"""Playtopia Proxy — main mitmproxy addon.

Logs REST (Supabase PostgREST / GoTrue) and WebSocket (Supabase Realtime /
Phoenix Channels) traffic for the Playtopia backend host, applies user-defined
modification rules, and streams events to the Electron frontend via the bridge.

Can be used standalone:   mitmdump -s addons/playtopia.py
or through run_backend.py (which is what the Electron app does).

The module deliberately does not import mitmproxy: hooks receive flow objects
duck-typed, which keeps the pure helpers (_get_ws_event, _set_path, rule
matching) unit-testable without a proxy.
"""

from __future__ import annotations

import copy
import json
import logging
import time
from typing import Any, Iterable, Optional

try:  # package import (run_backend.py, tests)
    from .bridge import Bridge
except ImportError:  # loaded as a script by `mitmdump -s addons/playtopia.py`
    from bridge import Bridge  # type: ignore[no-redef]

log = logging.getLogger("playtopia")

TARGET_HOST = "vihkaevvrneoelpasidf.supabase.co"
MAX_BODY = 2000
VERSION = "1.0.0"

REST_ACTIONS = {"replace_json_field", "string_replace"}
WS_ACTIONS = {"replace_json_field", "string_replace", "drop"}
REDACTED_HEADERS = {"authorization", "apikey", "cookie", "set-cookie"}

# Phoenix v2 array layout: [join_ref, ref, topic, event, payload]
PHX_V2_FIELDS = {"join_ref": 0, "ref": 1, "topic": 2, "event": 3, "payload": 4}

_MISSING = object()


# =========================================================================
# Pure helpers (unit-tested in backend/tests)
# =========================================================================

def _truncate(text: Optional[str], limit: int = MAX_BODY) -> str:
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"… [truncated, {len(text)} chars total]"


def _get_ws_event(data: Any) -> Optional[dict]:
    """Detect a Phoenix Channels message.

    Accepts an already-decoded JSON value (or a JSON string) and returns
    ``{"version": "v1"|"v2", "join_ref", "ref", "topic", "event", "payload"}``
    or ``None`` if the value is not a Phoenix message.
    """
    if isinstance(data, (str, bytes)):
        try:
            data = json.loads(data)
        except (ValueError, UnicodeDecodeError):
            return None

    if isinstance(data, dict):
        if isinstance(data.get("event"), str) and isinstance(data.get("topic"), str):
            return {
                "version": "v1",
                "join_ref": data.get("join_ref"),
                "ref": data.get("ref"),
                "topic": data["topic"],
                "event": data["event"],
                "payload": data.get("payload"),
            }
        return None

    if isinstance(data, list) and len(data) == 5:
        join_ref, ref, topic, event, payload = data
        if isinstance(topic, str) and isinstance(event, str) \
                and (join_ref is None or isinstance(join_ref, (str, int))) \
                and (ref is None or isinstance(ref, (str, int))):
            return {
                "version": "v2",
                "join_ref": join_ref,
                "ref": ref,
                "topic": topic,
                "event": event,
                "payload": payload,
            }
    return None


def _normalize_phoenix_path(data: Any, path: list) -> list:
    """Let users write ["payload", ...] for both Phoenix v1 and v2.

    For a v2 array message the first path segment may be a field name
    (join_ref/ref/topic/event/payload) which is mapped to its array index.
    """
    if path and isinstance(data, list) and isinstance(path[0], str) \
            and path[0] in PHX_V2_FIELDS and _get_ws_event(data) is not None:
        return [PHX_V2_FIELDS[path[0]], *path[1:]]
    return list(path)


def _resolve_key(container: Any, key: Any) -> Any:
    """Return the key usable on ``container`` or _MISSING if it doesn't exist."""
    if isinstance(container, dict):
        k = key if isinstance(key, str) else str(key)
        return k if k in container else _MISSING
    if isinstance(container, list):
        if isinstance(key, bool):
            return _MISSING
        if isinstance(key, str):
            try:
                key = int(key)
            except ValueError:
                return _MISSING
        if isinstance(key, int) and -len(container) <= key < len(container):
            return key
    return _MISSING


def _iter_keys(container: Any, key: Any) -> Iterable[Any]:
    if key == "*":
        if isinstance(container, dict):
            return list(container.keys())
        if isinstance(container, list):
            return list(range(len(container)))
        return []
    k = _resolve_key(container, key)
    return [] if k is _MISSING else [k]


def _set_path(obj: Any, path: list, value: Any) -> int:
    """Replace the value at ``path`` inside ``obj`` (in place).

    - string segments index objects; integer (or numeric-string) segments index arrays
    - ``"*"`` matches every element of an array / every value of an object
    - only *existing* fields are replaced; nothing is created
    Returns the number of replacements made.
    """
    if not path:
        return 0
    head, rest = path[0], path[1:]
    count = 0
    for k in _iter_keys(obj, head):
        if rest:
            count += _set_path(obj[k], rest, value)
        else:
            obj[k] = copy.deepcopy(value)
            count += 1
    return count


def _dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def apply_action(action: dict, text: str, *, phoenix: bool = False) -> tuple[Optional[str], str]:
    """Apply a text-transforming action.

    Returns ``(new_text, reason)``. ``new_text`` is None when nothing changed
    (``reason`` then explains why). ``drop`` is handled by the caller.
    """
    atype = action.get("type")
    if atype == "string_replace":
        src = action.get("from")
        if not isinstance(src, str) or src == "":
            return None, "string_replace needs a non-empty 'from'"
        if src not in text:
            return None, f"'{src[:40]}' not found"
        return text.replace(src, str(action.get("to", ""))), ""

    if atype == "replace_json_field":
        path = action.get("path")
        if not isinstance(path, list) or not path:
            return None, "replace_json_field needs a non-empty 'path'"
        try:
            data = json.loads(text)
        except ValueError:
            return None, "body is not JSON"
        if phoenix:
            path = _normalize_phoenix_path(data, path)
        n = _set_path(data, path, action.get("value"))
        if n == 0:
            return None, f"path {path!r} not found"
        return _dumps(data), ""

    return None, f"unsupported action '{atype}'"


def rule_matches(rule: dict, *, target: str, direction: str, path: str = "",
                 method: Optional[str] = None, event: Optional[str] = None,
                 text: str = "") -> bool:
    """Decide whether ``rule`` applies to a message.

    ``direction`` is always "client" (client→server) or "server" (server→client);
    for REST, client = request and server = response. Match fields that do not
    apply to the rule's target are ignored. An empty ``match`` is a wildcard.
    """
    if not rule.get("enabled", True) or rule.get("target") != target:
        return False
    m = rule.get("match") or {}
    if m.get("direction") and m["direction"] != direction:
        return False
    if m.get("path_contains") and m["path_contains"] not in (path or ""):
        return False
    if target == "rest" and m.get("method") and (method or "").upper() != m["method"].upper():
        return False
    if target == "ws" and m.get("event") and m["event"] != event:
        return False
    if m.get("contains") and m["contains"] not in (text or ""):
        return False
    return True


def validate_rule(rule: Any) -> Optional[str]:
    """Light structural validation (the UI does full JSON-Schema validation)."""
    if not isinstance(rule, dict):
        return "rule must be an object"
    if not isinstance(rule.get("id"), str) or not rule["id"]:
        return "rule.id must be a non-empty string"
    if rule.get("target") not in ("rest", "ws"):
        return "rule.target must be 'rest' or 'ws'"
    if not isinstance(rule.get("match", {}), dict):
        return "rule.match must be an object"
    action = rule.get("action")
    if not isinstance(action, dict):
        return "rule.action must be an object"
    allowed = REST_ACTIONS if rule["target"] == "rest" else WS_ACTIONS
    if action.get("type") not in allowed:
        return f"action '{action.get('type')}' not supported for target '{rule['target']}'"
    return None


def redact_headers(headers: Iterable[tuple[str, str]]) -> dict:
    out: dict[str, str] = {}
    for k, v in headers:
        if k.lower() in REDACTED_HEADERS and v:
            v = v[:12] + "…[redacted]"
        out[k] = v if k not in out else out[k] + ", " + v
    return out


# =========================================================================
# mitmproxy addon
# =========================================================================

class PlaytopiaAddon:
    def __init__(self, bridge: Optional[Bridge] = None, target_host: str = TARGET_HOST,
                 max_body: int = MAX_BODY, proxy_port: Optional[int] = None):
        self.bridge = bridge or Bridge()
        self.bridge.on_command = self.handle_command
        self.bridge.hello = {"role": "backend", "version": VERSION, "target_host": target_host,
                             "proxy_port": proxy_port}
        self.target_host = target_host
        self.max_body = max_body
        self.rules: dict[str, dict] = {}
        self.paused = False

    # ------------------------------------------------------------- lifecycle

    def running(self):
        self.bridge.start()
        log.info("Playtopia addon active - target host %s", self.target_host)

    async def done(self):
        await self.bridge.stop()

    # -------------------------------------------------------------- commands

    def handle_command(self, cmd: dict) -> None:
        t = cmd.get("type")
        if t == "set_rule":
            rule = cmd.get("rule")
            err = validate_rule(rule)
            if err:
                self._emit({"type": "error", "message": f"rejected rule: {err}",
                            "rule_id": rule.get("id") if isinstance(rule, dict) else None})
                return
            self.rules[rule["id"]] = rule
        elif t == "delete_rule":
            self.rules.pop(str(cmd.get("id")), None)
        elif t == "clear_rules":
            self.rules.clear()
        elif t == "set_paused":
            self.paused = bool(cmd.get("paused"))
        elif t == "ping":
            pass
        else:
            self._emit({"type": "error", "message": f"unknown command '{t}'"})
            return
        self._emit({"type": "state", "rule_count": len(self.rules), "paused": self.paused,
                    "rule_ids": list(self.rules)})

    def load_rules(self, rules: list) -> None:
        for r in rules:
            self.handle_command({"type": "set_rule", "rule": r})

    # --------------------------------------------------------------- helpers

    def _emit(self, event: dict) -> None:
        event.setdefault("timestamp", time.time())
        self.bridge.send(event)

    def _is_target(self, flow) -> bool:
        try:
            return self.target_host in flow.request.pretty_host
        except AttributeError:
            return False

    def _apply_rules(self, *, target: str, direction: str, path: str, text: str,
                     summary: str, method: Optional[str] = None,
                     event: Optional[str] = None) -> tuple[str, list, bool]:
        """Run all matching rules in order. Returns (text, applied_ids, drop)."""
        applied: list[str] = []
        for rule in list(self.rules.values()):
            if not rule_matches(rule, target=target, direction=direction, path=path,
                                method=method, event=event, text=text):
                continue
            action = rule.get("action") or {}
            if action.get("type") == "drop":
                if target != "ws":
                    continue
                applied.append(rule["id"])
                self._emit({"type": "rule_applied", "rule_id": rule["id"],
                            "flow_summary": summary, "action": "drop"})
                return text, applied, True
            new_text, reason = apply_action(action, text, phoenix=(target == "ws"))
            if new_text is None:
                self._emit({"type": "rule_noop", "rule_id": rule["id"],
                            "flow_summary": summary, "reason": reason})
                continue
            text = new_text
            applied.append(rule["id"])
            self._emit({"type": "rule_applied", "rule_id": rule["id"],
                        "flow_summary": summary, "action": action.get("type")})
        return text, applied, False

    # ----------------------------------------------------------------- REST

    def request(self, flow) -> None:
        if not self._is_target(flow) or self.paused:
            return
        # The realtime WebSocket upgrade is logged by the websocket hooks.
        req = flow.request
        body = req.get_text(strict=False) or ""
        original = body
        summary = f"REST request {req.method} {req.path}"
        body, applied, _ = self._apply_rules(target="rest", direction="client", path=req.path,
                                             text=body, method=req.method, summary=summary)
        if applied:
            req.set_text(body)
        self._emit({
            "type": "rest", "direction": "request", "flow_id": flow.id,
            "method": req.method, "path": req.path, "host": req.pretty_host, "status": None,
            "headers": redact_headers(req.headers.items(multi=True)),
            "body": _truncate(body, self.max_body),
            "original_body": _truncate(original, self.max_body) if applied else None,
            "rules_applied": applied,
        })

    def response(self, flow) -> None:
        if not self._is_target(flow) or self.paused or flow.response is None:
            return
        req, resp = flow.request, flow.response
        body = resp.get_text(strict=False) or ""
        original = body
        summary = f"REST response {req.method} {req.path} {resp.status_code}"
        body, applied, _ = self._apply_rules(target="rest", direction="server", path=req.path,
                                             text=body, method=req.method, summary=summary)
        if applied:
            resp.set_text(body)
        self._emit({
            "type": "rest", "direction": "response", "flow_id": flow.id,
            "method": req.method, "path": req.path, "host": req.pretty_host,
            "status": resp.status_code,
            "headers": redact_headers(resp.headers.items(multi=True)),
            "body": _truncate(body, self.max_body),
            "original_body": _truncate(original, self.max_body) if applied else None,
            "rules_applied": applied,
            "duration_ms": _duration_ms(flow),
        })

    def error(self, flow) -> None:
        if not self._is_target(flow):
            return
        self._emit({"type": "error", "flow_id": flow.id,
                    "message": f"{flow.request.method} {flow.request.path}: {flow.error}"})

    # ------------------------------------------------------------ WebSocket

    def websocket_start(self, flow) -> None:
        if self._is_target(flow) and not self.paused:
            self._emit({"type": "ws_lifecycle", "state": "open", "flow_id": flow.id,
                        "path": flow.request.path})

    def websocket_end(self, flow) -> None:
        if self._is_target(flow) and not self.paused:
            ws = flow.websocket
            self._emit({"type": "ws_lifecycle", "state": "closed", "flow_id": flow.id,
                        "path": flow.request.path,
                        "close_code": getattr(ws, "close_code", None),
                        "close_reason": getattr(ws, "close_reason", None)})

    def websocket_message(self, flow) -> None:
        if not self._is_target(flow) or self.paused:
            return
        msg = flow.websocket.messages[-1]
        direction = "client" if msg.from_client else "server"
        is_binary = not msg.is_text
        length = len(msg.content)
        ev: dict[str, Any] = {
            "type": "ws", "direction": direction, "flow_id": flow.id,
            "path": flow.request.path, "is_binary": is_binary, "length": length,
            "phx_version": None, "topic": None, "event": None, "ref": None,
            "rules_applied": [], "dropped": False, "original_text": None,
        }

        if is_binary:
            ev["text"] = _truncate(msg.content[:1024].hex(" "), self.max_body)
            self._emit(ev)
            return

        text = msg.text
        phx = _get_ws_event(text)
        if phx:
            ev.update(phx_version=phx["version"], topic=phx["topic"], event=phx["event"],
                      ref=phx["ref"])
        summary = f"WS {direction} {phx['topic'] + ' ' + phx['event'] if phx else '(non-phoenix)'}"
        new_text, applied, drop = self._apply_rules(
            target="ws", direction=direction, path=flow.request.path, text=text,
            event=phx["event"] if phx else None, summary=summary)
        if drop:
            msg.drop()
            ev["dropped"] = True
        elif applied:
            msg.text = new_text
            ev["original_text"] = _truncate(text, self.max_body)
        ev["rules_applied"] = applied
        ev["text"] = _truncate(new_text, self.max_body)
        self._emit(ev)

    # ------------------------------------------------------------------ TLS

    def tls_failed_client(self, data) -> None:
        """Client refused our certificate — almost always 'CA not installed'."""
        sni = getattr(data.conn, "sni", None) or ""
        if self.target_host not in sni:
            return
        self._emit({"type": "tls_error", "host": sni,
                    "message": f"TLS handshake with the game client failed for {sni}: "
                               f"{getattr(data.conn, 'error', None) or 'unknown error'}. "
                               "The mitmproxy CA certificate is probably not installed "
                               "(or the client pins certificates)."})

    def tls_failed_server(self, data) -> None:
        sni = getattr(data.conn, "sni", None) or ""
        if self.target_host in sni:
            self._emit({"type": "error",
                        "message": f"TLS to upstream {sni} failed: "
                                   f"{getattr(data.conn, 'error', None)}"})


def _duration_ms(flow) -> Optional[float]:
    try:
        return round((flow.response.timestamp_end - flow.request.timestamp_start) * 1000, 1)
    except (AttributeError, TypeError):
        return None


# Standalone use: `mitmdump -s addons/playtopia.py` (no Electron needed; events
# are also printed to the console).
addons = [PlaytopiaAddon(Bridge(echo=True))]
