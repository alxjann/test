"""Unit tests for the pure helpers in addons/playtopia.py.

    cd backend && python -m unittest discover -s tests -v
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from addons.playtopia import (  # noqa: E402
    PlaytopiaAddon, _get_ws_event, _normalize_phoenix_path, _set_path, apply_action,
    rule_matches, validate_rule,
)


class GetWsEventTests(unittest.TestCase):
    def test_v1_object(self):
        msg = {"topic": "realtime:world", "event": "phx_join", "payload": {"a": 1}, "ref": "1"}
        ev = _get_ws_event(msg)
        self.assertEqual(ev["version"], "v1")
        self.assertEqual(ev["event"], "phx_join")
        self.assertEqual(ev["topic"], "realtime:world")
        self.assertEqual(ev["payload"], {"a": 1})

    def test_v1_from_string(self):
        ev = _get_ws_event('{"topic":"phoenix","event":"heartbeat","payload":{},"ref":"5"}')
        self.assertEqual(ev["event"], "heartbeat")

    def test_v2_array(self):
        ev = _get_ws_event('["1","2","realtime:world","phx_reply",{"status":"ok"}]')
        self.assertEqual(ev["version"], "v2")
        self.assertEqual(ev["join_ref"], "1")
        self.assertEqual(ev["ref"], "2")
        self.assertEqual(ev["event"], "phx_reply")
        self.assertEqual(ev["payload"], {"status": "ok"})

    def test_v2_null_refs(self):
        ev = _get_ws_event([None, None, "realtime:x", "broadcast", {}])
        self.assertEqual(ev["version"], "v2")

    def test_not_phoenix(self):
        self.assertIsNone(_get_ws_event("not json"))
        self.assertIsNone(_get_ws_event({"foo": 1}))
        self.assertIsNone(_get_ws_event([1, 2, 3]))
        self.assertIsNone(_get_ws_event([1, 2, 3, 4, 5]))  # topic/event not strings
        self.assertIsNone(_get_ws_event(42))


class SetPathTests(unittest.TestCase):
    def test_nested(self):
        d = {"a": {"b": 1}}
        self.assertEqual(_set_path(d, ["a", "b"], 2), 1)
        self.assertEqual(d, {"a": {"b": 2}})

    def test_missing_is_not_created(self):
        d = {"a": {}}
        self.assertEqual(_set_path(d, ["a", "b"], 2), 0)
        self.assertEqual(d, {"a": {}})

    def test_list_index_int_and_str(self):
        d = [{"x": 1}, {"x": 2}]
        self.assertEqual(_set_path(d, [1, "x"], 9), 1)
        self.assertEqual(_set_path(d, ["0", "x"], 8), 1)
        self.assertEqual(d, [{"x": 8}, {"x": 9}])

    def test_index_out_of_range(self):
        self.assertEqual(_set_path([1], [5], 0), 0)

    def test_wildcard(self):
        d = [{"name": "a"}, {"name": "b"}, {"other": 1}]
        self.assertEqual(_set_path(d, ["*", "name"], "z"), 2)
        self.assertEqual(d, [{"name": "z"}, {"name": "z"}, {"other": 1}])

    def test_value_is_copied(self):
        v = {"k": [1]}
        d = [{"a": 0}, {"a": 0}]
        _set_path(d, ["*", "a"], v)
        d[0]["a"]["k"].append(2)
        self.assertEqual(d[1]["a"], {"k": [1]})

    def test_empty_path(self):
        self.assertEqual(_set_path({"a": 1}, [], 2), 0)

    def test_scalar_container(self):
        self.assertEqual(_set_path({"a": 1}, ["a", "b"], 2), 0)


class PhoenixPathTests(unittest.TestCase):
    def test_v2_payload_mapped(self):
        msg = ["1", "2", "t", "broadcast", {"m": "hi"}]
        self.assertEqual(_normalize_phoenix_path(msg, ["payload", "m"]), [4, "m"])

    def test_v1_untouched(self):
        msg = {"topic": "t", "event": "e", "payload": {}}
        self.assertEqual(_normalize_phoenix_path(msg, ["payload", "m"]), ["payload", "m"])

    def test_apply_v2(self):
        text = json.dumps(["1", "2", "t", "broadcast", {"payload": {"message": "hi"}}])
        out, _ = apply_action({"type": "replace_json_field",
                               "path": ["payload", "payload", "message"], "value": "yo"},
                              text, phoenix=True)
        self.assertEqual(json.loads(out)[4]["payload"]["message"], "yo")


class ApplyActionTests(unittest.TestCase):
    def test_string_replace(self):
        out, _ = apply_action({"type": "string_replace", "from": "cat", "to": "dog"}, "cat cat")
        self.assertEqual(out, "dog dog")

    def test_string_replace_miss(self):
        out, reason = apply_action({"type": "string_replace", "from": "x", "to": "y"}, "abc")
        self.assertIsNone(out)
        self.assertIn("not found", reason)

    def test_json_non_json_body(self):
        out, reason = apply_action({"type": "replace_json_field", "path": ["a"], "value": 1}, "<html>")
        self.assertIsNone(out)
        self.assertIn("not JSON", reason)

    def test_json_replace(self):
        out, _ = apply_action({"type": "replace_json_field", "path": ["*", "display_name"],
                               "value": "Tester"}, '[{"display_name":"Bob","id":1}]')
        self.assertEqual(json.loads(out), [{"display_name": "Tester", "id": 1}])


class RuleMatchTests(unittest.TestCase):
    def rule(self, **match):
        return {"id": "r", "enabled": True, "target": "rest", "match": match,
                "action": {"type": "string_replace", "from": "a", "to": "b"}}

    def test_wildcard(self):
        self.assertTrue(rule_matches(self.rule(), target="rest", direction="server"))

    def test_disabled(self):
        r = self.rule()
        r["enabled"] = False
        self.assertFalse(rule_matches(r, target="rest", direction="server"))

    def test_target_mismatch(self):
        self.assertFalse(rule_matches(self.rule(), target="ws", direction="server"))

    def test_method_path_direction(self):
        r = self.rule(method="get", path_contains="/rest/v1/profiles", direction="server")
        self.assertTrue(rule_matches(r, target="rest", direction="server", method="GET",
                                     path="/rest/v1/profiles?select=*"))
        self.assertFalse(rule_matches(r, target="rest", direction="client", method="GET",
                                      path="/rest/v1/profiles"))
        self.assertFalse(rule_matches(r, target="rest", direction="server", method="POST",
                                      path="/rest/v1/profiles"))

    def test_ws_event_and_contains(self):
        r = {"id": "w", "target": "ws", "match": {"event": "broadcast", "contains": "chat"},
             "action": {"type": "drop"}}
        self.assertTrue(rule_matches(r, target="ws", direction="server", event="broadcast",
                                     text='{"chat":1}'))
        self.assertFalse(rule_matches(r, target="ws", direction="server", event="presence",
                                      text='{"chat":1}'))


class ValidateRuleTests(unittest.TestCase):
    def test_drop_rest_rejected(self):
        self.assertIsNotNone(validate_rule({"id": "x", "target": "rest", "action": {"type": "drop"}}))

    def test_ok(self):
        self.assertIsNone(validate_rule({"id": "x", "target": "ws", "action": {"type": "drop"}}))


class _Recorder:
    def __init__(self):
        self.events = []
        self.on_command = None
        self.hello = {}

    def send(self, ev):
        self.events.append(ev)


class AddonCommandTests(unittest.TestCase):
    def test_commands(self):
        rec = _Recorder()
        addon = PlaytopiaAddon(rec)
        rule = {"id": "a", "target": "ws", "action": {"type": "drop"}}
        rec.on_command({"type": "set_rule", "rule": rule})
        self.assertIn("a", addon.rules)
        rec.on_command({"type": "set_paused", "paused": True})
        self.assertTrue(addon.paused)
        rec.on_command({"type": "delete_rule", "id": "a"})
        self.assertEqual(addon.rules, {})
        rec.on_command({"type": "set_rule", "rule": rule})
        rec.on_command({"type": "clear_rules"})
        self.assertEqual(addon.rules, {})
        rec.on_command({"type": "set_rule", "rule": {"id": "bad"}})
        self.assertEqual(rec.events[-1]["type"], "error")


if __name__ == "__main__":
    unittest.main()
