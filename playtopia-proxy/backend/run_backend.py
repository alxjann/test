"""Playtopia Proxy backend entry point.

Starts mitmdump programmatically with the Playtopia addons.

    python run_backend.py                      # used by the Electron app
    python run_backend.py --headless           # no Electron: print events to console
    python run_backend.py --headless --rules my_rules.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import sys

# Make `addons` importable no matter what the current working directory is
# (and inside a PyInstaller bundle).
_HERE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from addons.bridge import Bridge  # noqa: E402
from addons.playtopia import MAX_BODY, TARGET_HOST, PlaytopiaAddon  # noqa: E402


class StartupNotice:
    """Prints the ready line once mitmproxy's listeners are up."""

    def __init__(self, host: str, port: int):
        self.host, self.port = host, port

    def running(self):
        print(f"[playtopia-proxy] backend listening on {self.host}:{self.port}", flush=True)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Playtopia Proxy backend (mitmproxy)")
    p.add_argument("--port", type=int, default=8080, help="proxy listen port (default 8080)")
    p.add_argument("--listen-host", default="127.0.0.1", help="proxy listen address")
    p.add_argument("--bridge-port", type=int, default=8765,
                   help="port of the Electron bridge WebSocket server (default 8765)")
    p.add_argument("--headless", action="store_true",
                   help="run without the Electron UI: no bridge, events printed to the console")
    p.add_argument("--rules", help="JSON file containing a list of rules to load at startup")
    p.add_argument("--target-host", default=TARGET_HOST, help="backend hostname to intercept")
    p.add_argument("--max-body", type=int, default=MAX_BODY,
                   help="truncate logged bodies to this many characters (default 2000)")
    p.add_argument("--mode", default="regular",
                   help="mitmproxy mode, e.g. 'regular' (default) or 'local:Playtopia.exe'")
    p.add_argument("--intercept-all", action="store_true",
                   help="MITM every host (default: only the target host; others are tunnelled)")
    p.add_argument("--parent-pid", type=int,
                   help="exit automatically when this process (the Electron app) dies")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return p.parse_args(argv)


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        # NB: os.kill(pid, 0) would *terminate* the process on Windows.
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = k32.GetExitCodeProcess(handle, ctypes.byref(code))
        k32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


async def _watch_parent(pid: int, master) -> None:
    while True:
        await asyncio.sleep(2)
        if not _pid_alive(pid):
            print(f"[playtopia-proxy] parent process {pid} is gone; exiting", flush=True)
            master.shutdown()
            return


async def run(args) -> int:
    from mitmproxy import options
    from mitmproxy.tools.dump import DumpMaster

    opts = options.Options()
    master = DumpMaster(opts, with_termlog=True, with_dumper=False)

    update = dict(
        listen_host=args.listen_host,
        listen_port=args.port,
        mode=[args.mode],
        termlog_verbosity="debug" if args.verbose else "info",
    )
    if not args.intercept_all:
        # Only decrypt the game backend; everything else passes through untouched,
        # so a system-wide proxy setting doesn't break other apps.
        update["allow_hosts"] = [re.escape(args.target_host)]
    master.options.update(**update)

    bridge = Bridge(port=args.bridge_port, enabled=not args.headless, echo=args.headless)
    addon = PlaytopiaAddon(bridge, target_host=args.target_host, max_body=args.max_body,
                           proxy_port=args.port)
    if args.rules:
        with open(args.rules, encoding="utf-8") as f:
            rules = json.load(f)
        addon.load_rules(rules if isinstance(rules, list) else [rules])
        print(f"[playtopia-proxy] loaded {len(addon.rules)} rule(s) from {args.rules}", flush=True)

    master.addons.add(addon, StartupNotice(args.listen_host, args.port))

    def _stop(*_):
        print("[playtopia-proxy] shutting down", flush=True)
        master.shutdown()  # thread-safe

    signal.signal(signal.SIGINT, _stop)
    if hasattr(signal, "SIGBREAK"):  # Ctrl+Break / console close on Windows
        signal.signal(signal.SIGBREAK, _stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _stop)

    watchdog = asyncio.create_task(_watch_parent(args.parent_pid, master)) if args.parent_pid else None
    try:
        await master.run()
    finally:
        if watchdog:
            watchdog.cancel()
    return 0


def main(argv=None) -> int:
    args = parse_args(argv)
    # Game text can contain anything (emoji, CJK); never crash on a cp1252 pipe.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    # mitmproxy's termlog addon owns console logging (see termlog_verbosity above).
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 0
    except OSError as e:
        print(f"[playtopia-proxy] fatal: {e}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
