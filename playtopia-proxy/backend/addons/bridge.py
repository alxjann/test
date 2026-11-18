"""WebSocket client that connects the mitmproxy backend to the Electron frontend.

The frontend runs a WebSocket *server* on ws://127.0.0.1:<bridge_port>. This
module is the client side: it connects, reconnects every 2 seconds on failure,
queues outgoing events while disconnected, and dispatches incoming commands to
a callback.

stdin/stdout are deliberately NOT used as the transport: mitmproxy writes logs
to the console, which would corrupt a stdio-based channel.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque
from typing import Any, Callable, Optional

log = logging.getLogger("playtopia.bridge")

RECONNECT_DELAY = 2.0
MAX_QUEUED_EVENTS = 2000


class Bridge:
    def __init__(self, port: int = 8765, host: str = "127.0.0.1", enabled: bool = True,
                 echo: bool = False):
        self.url = f"ws://{host}:{port}"
        self.enabled = enabled
        self.echo = echo  # print a one-line summary of every event (headless mode)
        self.on_command: Optional[Callable[[dict], None]] = None
        self.hello: dict = {}

        self._pending: deque[str] = deque(maxlen=MAX_QUEUED_EVENTS)
        self._wakeup: Optional[asyncio.Event] = None
        self._task: Optional[asyncio.Task] = None
        self._ws: Any = None

    # ------------------------------------------------------------------ public

    @property
    def connected(self) -> bool:
        return self._ws is not None

    def start(self) -> None:
        """Spawn the connect/reconnect loop. Must be called from the event loop."""
        if not self.enabled or self._task is not None:
            return
        self._wakeup = asyncio.Event()
        self._task = asyncio.get_running_loop().create_task(self._run(), name="playtopia-bridge")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    def send(self, event: dict) -> None:
        """Queue an event for the frontend. Safe to call from mitmproxy hooks."""
        if self.echo:
            _print_event(event)
        if not self.enabled:
            return
        try:
            data = json.dumps(event, ensure_ascii=False, default=str)
        except (TypeError, ValueError) as e:
            log.warning("could not serialise event: %s", e)
            return
        self._pending.append(data)  # deque drops the oldest event when full
        if self._wakeup is not None:
            self._wakeup.set()

    # ---------------------------------------------------------------- internal

    async def _run(self) -> None:
        import websockets  # imported lazily so pure helpers stay importable without it

        while True:
            try:
                async with websockets.connect(self.url, max_size=None, ping_interval=20,
                                              open_timeout=5) as ws:
                    self._ws = ws
                    log.info("bridge connected to %s", self.url)
                    await ws.send(json.dumps({"type": "hello", **self.hello}))
                    sender = asyncio.create_task(self._sender(ws))
                    try:
                        async for raw in ws:
                            self._dispatch(raw)
                    finally:
                        sender.cancel()
                        self._ws = None
                    log.info("bridge disconnected")
            except asyncio.CancelledError:
                raise
            except Exception as e:  # connection refused, reset, timeout, ...
                self._ws = None
                log.debug("bridge connect failed (%s); retrying in %.0fs", e, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)

    async def _sender(self, ws) -> None:
        assert self._wakeup is not None
        while True:
            while self._pending:
                data = self._pending[0]
                await ws.send(data)
                self._pending.popleft()
            self._wakeup.clear()
            await self._wakeup.wait()

    def _dispatch(self, raw: Any) -> None:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        try:
            cmd = json.loads(raw)
        except ValueError:
            log.warning("bridge: ignoring non-JSON command")
            return
        if not isinstance(cmd, dict):
            return
        if self.on_command:
            try:
                self.on_command(cmd)
            except Exception:
                log.exception("bridge: command handler failed for %r", cmd.get("type"))


def _print_event(ev: dict) -> None:
    t = ev.get("type")
    if t == "rest":
        status = f" {ev.get('status')}" if ev.get("status") is not None else ""
        line = f"REST {ev.get('direction'):8} {ev.get('method')} {ev.get('path')}{status}"
    elif t == "ws":
        what = ev.get("event") or ("<binary>" if ev.get("is_binary") else "")
        line = f"WS   {ev.get('direction'):8} {ev.get('topic') or ''} {what} ({ev.get('length')}B)"
    elif t == "rule_applied":
        line = f"RULE {ev.get('rule_id')} -> {ev.get('flow_summary')}"
    else:
        line = f"{str(t).upper():4} {json.dumps({k: v for k, v in ev.items() if k != 'type'}, default=str)[:200]}"
    print(f"[event] {line}", flush=True)
