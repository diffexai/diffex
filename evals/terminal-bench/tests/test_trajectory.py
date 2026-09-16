"""ATIF validation and exact accounting against controlled native evidence."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

from harbor.models.agent.context import AgentContext
from harbor.utils.trajectory_validator import TrajectoryValidator

from diffex_terminal_bench.trajectory import export_trajectory


USAGE = {"input": 11, "output": 7, "cacheRead": 5, "cacheWrite": 3,
         "totalTokens": 26, "cost": {"total": 0.125}}


def assistant(response_id, content=None, **kwargs):
    return {"role": "assistant", "provider": "openai", "model": "gpt-5", "responseId": response_id,
            "timestamp": 1000, "content": content or [{"type": "text", "text": "done"}],
            "stopReason": "stop", "usage": copy.deepcopy(USAGE), **kwargs}


def entry(identifier, message):
    return {"type": "message", "id": identifier, "message": message,
            "timestamp": "1970-01-01T00:00:01Z" if message.get("timestamp", 1000) == 1000 else "1970-01-01T00:00:02Z"}


def interrupted_child_records(*, status="interrupted", stop_reason="aborted", interrupt_error=False, usage=None):
    root = [entry("spawn", assistant("spawn", [{"type": "toolCall", "id": "spawn", "name": "spawn_agent",
                                              "arguments": {"name": "helper"}}])),
            entry("spawn-result", {"role": "toolResult", "toolCallId": "spawn", "content": "accepted", "isError": False}),
            entry("interrupt", assistant("interrupt", [{"type": "toolCall", "id": "interrupt", "name": "agent_action",
                                                       "arguments": {"target": "helper", "action": "interrupt"}}])),
            entry("interrupt-result", {"role": "toolResult", "toolCallId": "interrupt", "content": "interrupted",
                                       "isError": interrupt_error}),
            {"type": "custom", "id": "snapshot", "customType": "diffex.subagents",
             "data": {"agents": [{"name": "helper", "childSessionId": "child", "status": status}]}},
            entry("done", assistant("done"))]
    child = [entry("child-first", assistant("child-first", model="gpt-4")),
             entry("child-last", assistant("child-last", model="gpt-4", stopReason=stop_reason,
                   usage=usage if usage is not None else {"input": 0, "output": 0, "cacheRead": 0,
                                                         "cacheWrite": 0, "cost": {"total": 0}}))]
    return root, child


class TrajectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.context = AgentContext()
        (self.directory / "requested.json").write_text(json.dumps({"provider": "openai", "model": "gpt-5", "thinking": "high"}))
        (self.directory / "stdout.jsonl").write_text("")

    def session(self, records, identifier="root", parent=None):
        path = self.directory / "sessions" / ("root.jsonl" if identifier == "root" else f".subagents/{identifier}.jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        header = {"type": "session", "id": identifier, "timestamp": "1970-01-01T00:00:00Z", "parentSession": parent}
        path.write_text("".join(json.dumps(record) + "\n" for record in [header, *records]))
        return path

    def export(self, status="completed"):
        destination = self.directory / "trajectory.json"
        accounting = export_trajectory(self.directory, destination, self.context,
                                       {"status": status, "stream_complete": status == "completed"})
        validator = TrajectoryValidator()
        self.assertTrue(validator.validate(destination), validator.get_errors())
        return json.loads(destination.read_text()), accounting

    def test_messages_tools_and_event_copies_count_once(self):
        message = assistant("one", [{"type": "thinking", "thinking": "inspect"},
                                    {"type": "toolCall", "id": "call-1", "name": "bash", "arguments": {"command": "pwd"}}])
        records = [entry("user", {"role": "user", "content": "task"}), entry("one", message),
                   entry("tool", {"role": "toolResult", "toolCallId": "call-1", "content": [{"type": "text", "text": "/task"}], "isError": False}),
                   entry("two", assistant("two"))]
        self.session(records)
        events = [{"type": "message_start", "message": message}, {"type": "message_update", "message": message},
                  {"type": "message_end", "message": message}, {"type": "turn_end", "message": message},
                  {"type": "agent_end", "messages": [message]}]
        (self.directory / "stdout.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
        document, accounting = self.export()
        self.assertTrue(accounting["complete"])
        self.assertEqual(accounting["totals"], {"prompt_tokens": 38, "completion_tokens": 14, "cached_tokens": 10, "cost_usd": 0.25})
        self.assertEqual(self.context.n_input_tokens, 38)
        self.assertEqual(self.context.model_usage["openai/gpt-5"].cost_usd, 0.25)
        self.assertEqual(len(document["steps"]), 3)
        step = document["steps"][1]
        self.assertEqual(step["reasoning_content"], "inspect")
        self.assertEqual(step["observation"]["results"][0]["source_call_id"], "call-1")

    def test_embedded_children_and_repeated_snapshots(self):
        spawn = assistant("spawn", [{"type": "toolCall", "id": "spawn-call", "name": "spawn_agent", "arguments": {"name": "helper"}}])
        snapshot = {"type": "custom", "customType": "diffex.subagents", "data": {"agents": [{"name": "helper", "childSessionId": "child"}]}}
        self.session([entry("spawn", spawn), {**snapshot, "id": "state-1"},
                      entry("result", {"role": "toolResult", "toolCallId": "spawn-call", "content": "accepted"}),
                      {**snapshot, "id": "state-2"}, entry("done", assistant("done"))])
        self.session([entry("child-one", assistant("spawn", model="gpt-4"))], "child", "root")
        document, accounting = self.export()
        self.assertTrue(accounting["complete"])
        self.assertEqual(self.context.n_input_tokens, 57)
        self.assertEqual(self.context.model_usage["openai/gpt-4"].n_output_tokens, 7)
        self.assertEqual(len(document["subagent_trajectories"]), 1)
        reference = document["steps"][0]["observation"]["results"][0]["subagent_trajectory_ref"][0]
        self.assertEqual(reference["trajectory_id"], document["subagent_trajectories"][0]["trajectory_id"])

    def test_auxiliary_usage_is_counted_without_model_guessing(self):
        self.session([entry("one", assistant("one")), {"type": "compaction", "id": "compact", "summary": "summary", "usage": USAGE},
                      {"type": "branch_summary", "id": "branch", "summary": "branch", "usage": USAGE}])
        document, accounting = self.export()
        self.assertTrue(accounting["complete"])
        self.assertEqual(self.context.n_input_tokens, 57)
        self.assertEqual(self.context.model_usage["unattributed"].n_input_tokens, 38)
        self.assertEqual(document["steps"][1]["model_name"], "unattributed")

    def test_intentional_child_interruption_retains_partial_aggregate(self):
        root, child = interrupted_child_records()
        self.session(root)
        self.session(child, "child", "root")
        document, accounting = self.export()
        self.assertFalse(accounting["complete"])
        self.assertEqual(accounting["gaps"], [])
        self.assertEqual(accounting["missing_fields"], ["cached_tokens", "completion_tokens", "cost_usd", "prompt_tokens"])
        self.assertEqual(accounting["totals"], {"prompt_tokens": 76, "completion_tokens": 28, "cached_tokens": 20, "cost_usd": 0.5})
        self.assertEqual(self.context.n_input_tokens, 76)
        self.assertEqual(self.context.cost_usd, 0.5)
        self.assertFalse(self.context.metadata["diffex_accounting"]["complete"])
        self.assertEqual(accounting["observed_model_usage"]["openai/gpt-4"]["prompt_tokens"], 19)
        self.assertEqual(document["final_metrics"]["total_prompt_tokens"], 76)
        child_document = document["subagent_trajectories"][0]
        self.assertEqual(child_document["extra"]["execution_status"], "interrupted")
        self.assertEqual(child_document["final_metrics"]["total_prompt_tokens"], 19)
        self.assertFalse(child_document["final_metrics"]["extra"]["accounting_complete"])
        self.assertNotIn("prompt_tokens", child_document["steps"][-1]["metrics"])

    def test_intentional_child_interruption_with_telemetry_is_complete(self):
        root, child = interrupted_child_records(usage=USAGE)
        self.session(root)
        self.session(child, "child", "root")
        _, accounting = self.export()
        self.assertTrue(accounting["complete"])
        self.assertEqual(self.context.n_input_tokens, 95)
        self.assertEqual(self.context.model_usage["openai/gpt-4"].n_input_tokens, 38)

    def test_child_errors_and_unproven_interruptions_remain_invalid(self):
        for options in ({"status": "running"}, {"interrupt_error": True}, {"stop_reason": "error"}):
            with self.subTest(options=options):
                root, child = interrupted_child_records(**options)
                self.session(root)
                self.session(child, "child", "root")
                _, accounting = self.export()
                self.assertIn("child:child_execution_incomplete", accounting["gaps"])
                self.assertIsNone(self.context.n_input_tokens)

    def test_intentional_abort_can_end_during_tool_call_generation(self):
        for call in ({"type": "toolCall", "id": "pending", "name": "bash", "arguments": {}},
                     {"type": "toolCall", "name": "bash"}):
            with self.subTest(call=call):
                root, child = interrupted_child_records()
                child[-1]["message"]["content"] = [call]
                self.session(root)
                self.session(child, "child", "root")
                _, accounting = self.export()
                self.assertEqual(accounting["gaps"], [])
                self.assertFalse(accounting["complete"])
                self.assertEqual(self.context.n_input_tokens, 76)
                # Missing results from earlier dispatched calls remain errors.
                child[0]["message"]["content"] = [{"type": "toolCall", "id": "earlier", "name": "bash", "arguments": {}}]
                self.session(child, "child", "root")
                _, accounting = self.export()
                self.assertIn("child:missing_tool_result", accounting["gaps"])

    def test_intentional_interruption_during_tool_execution_is_valid(self):
        root, child = interrupted_child_records(stop_reason="toolUse", usage=USAGE)
        child[-1]["message"]["content"] = [{"type": "toolCall", "id": "bash", "name": "bash", "arguments": {}}]
        child.append(entry("cancelled-tool", {"role": "toolResult", "toolCallId": "bash", "content": "cancelled", "isError": True}))
        self.session(root)
        self.session(child, "child", "root")
        _, accounting = self.export()
        self.assertTrue(accounting["complete"])
        self.assertEqual(self.context.n_input_tokens, 95)

    def test_nested_partial_child_totals_preserve_known_descendant_usage(self):
        root, child = interrupted_child_records()
        self.session(child, "grandchild", "child")
        # Rename the interrupted child reference inside the intermediate parent.
        root[-2]["data"]["agents"][0]["childSessionId"] = "grandchild"
        self.session(root, "child", "root")
        self.session([entry("spawn", assistant("spawn", [{"type": "toolCall", "id": "spawn", "name": "spawn_agent",
                                                         "arguments": {"name": "helper"}}])),
                      entry("spawn-result", {"role": "toolResult", "toolCallId": "spawn", "content": "accepted"}),
                      {"type": "custom", "id": "snapshot", "customType": "diffex.subagents",
                       "data": {"agents": [{"name": "helper", "childSessionId": "child", "status": "idle"}]}},
                      entry("done", assistant("done"))])
        document, accounting = self.export()
        self.assertEqual(accounting["gaps"], [])
        self.assertFalse(accounting["complete"])
        self.assertEqual(self.context.n_input_tokens, 114)
        middle = document["subagent_trajectories"][0]
        self.assertEqual(middle["final_metrics"]["total_prompt_tokens"], 76)
        self.assertFalse(middle["final_metrics"]["extra"]["accounting_complete"])
        self.assertEqual(middle["subagent_trajectories"][0]["final_metrics"]["total_prompt_tokens"], 19)

    def test_missing_compaction_usage_does_not_invent_zero(self):
        self.session([entry("one", assistant("one")), {"type": "compaction", "id": "compact", "summary": "summary"}])
        document, accounting = self.export()
        self.assertFalse(accounting["complete"])
        self.assertEqual(self.context.n_input_tokens, 19)
        self.assertEqual(accounting["observed_usage"]["prompt_tokens"], 19)
        self.assertEqual(document["final_metrics"]["total_prompt_tokens"], 19)
        self.assertNotIn("prompt_tokens", document["steps"][-1]["metrics"])
        self.assertEqual(self.context.model_usage, {})

    def test_interrupted_output_keeps_pending_message_and_intact_records(self):
        self.session([entry("one", assistant("one"))])
        partial = assistant("partial", [{"type": "text", "text": "unfinished"}], timestamp=2000)
        (self.directory / "stdout.jsonl").write_text(json.dumps({"type": "message_update", "message": partial}) + '\n{"type":')
        document, accounting = self.export("cancelled")
        self.assertEqual(len(document["steps"]), 2)
        self.assertTrue(document["steps"][1]["extra"]["partial"])
        self.assertIsNone(self.context.cost_usd)
        self.assertEqual(accounting["observed_usage"]["cost_usd"], 0.125)

    def test_recovered_retry_retains_unpersisted_failed_response(self):
        final = assistant("success", timestamp=2000)
        error = assistant("error", stopReason="error")
        self.session([entry("success", final)])
        events = [{"type": "message_end", "message": error}, {"type": "agent_end", "messages": [error]},
                  {"type": "message_end", "message": final}]
        (self.directory / "stdout.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
        document, accounting = self.export()
        self.assertTrue(accounting["complete"])
        self.assertEqual(self.context.cost_usd, 0.25)
        self.assertEqual(document["steps"][0]["extra"]["stop_reason"], "error")

    def test_missing_cost_preserves_known_token_totals(self):
        message = assistant("one")
        del message["usage"]["cost"]
        self.session([entry("one", message)])
        _, accounting = self.export()
        self.assertEqual(self.context.n_input_tokens, 19)
        self.assertIsNone(self.context.cost_usd)
        self.assertEqual(accounting["missing_fields"], ["cost_usd"])

    def test_missing_child_and_zero_initialized_usage_are_explicit(self):
        message = assistant("one", usage={"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0}})
        self.session([entry("one", message), {"type": "custom", "id": "snapshot", "customType": "diffex.subagents",
                      "data": {"agents": [{"name": "helper", "childSessionId": "missing"}]}}])
        _, accounting = self.export()
        self.assertFalse(accounting["complete"])
        self.assertTrue(any("missing_child_trajectory" in gap for gap in accounting["gaps"]))
        self.assertIsNone(self.context.n_cache_tokens)

    def test_orphan_observation_and_images_survive(self):
        self.session([entry("tool", {"role": "toolResult", "toolCallId": "lost", "content": [{"type": "image", "mimeType": "image/png", "data": "AAAA"}]})])
        document, accounting = self.export("cancelled")
        observation = document["steps"][0]["observation"]["results"][0]
        self.assertNotIn("source_call_id", observation)
        self.assertEqual((self.directory / observation["content"][0]["source"]["path"]).read_bytes(), b"\x00\x00\x00")
        self.assertFalse(accounting["complete"])

    def test_empty_evidence_cannot_produce_a_fabricated_trajectory(self):
        self.session([])
        with self.assertRaisesRegex(ValueError, "no recoverable"):
            self.export("cancelled")
        self.assertTrue((self.directory / "accounting.json").is_file())

    def test_nested_children_include_descendants_in_each_total(self):
        for identifier, child in (("root", "child"), ("child", "grandchild")):
            spawn = assistant(identifier, [{"type": "toolCall", "id": identifier, "name": "spawn_agent", "arguments": {"name": child}}])
            self.session([entry(f"call-{identifier}", spawn), entry("result", {"role": "toolResult", "toolCallId": identifier, "content": "accepted"}),
                          {"type": "custom", "id": "snapshot", "customType": "diffex.subagents",
                           "data": {"agents": [{"name": child, "childSessionId": child}]}},
                          entry("final", assistant(f"{identifier}-final"))], identifier)
        self.session([entry("final", assistant("grandchild-final"))], "grandchild")
        document, accounting = self.export()
        self.assertTrue(accounting["complete"])
        self.assertEqual(document["final_metrics"]["total_prompt_tokens"], 95)
        child = document["subagent_trajectories"][0]
        self.assertEqual(child["final_metrics"]["total_prompt_tokens"], 57)
        self.assertEqual(child["subagent_trajectories"][0]["final_metrics"]["total_prompt_tokens"], 19)

    def test_tool_end_recovers_observation_before_message_persistence(self):
        self.session([entry("one", assistant("one", [{"type": "toolCall", "id": "call", "name": "bash", "arguments": {}}]))])
        (self.directory / "stdout.jsonl").write_text(json.dumps({"type": "tool_execution_end", "toolCallId": "call",
                                                               "result": {"content": [{"type": "text", "text": "recovered"}]}}) + "\n")
        document, _ = self.export("cancelled")
        self.assertEqual(document["steps"][0]["observation"]["results"][0]["content"], "recovered")

    def test_partial_tool_arguments_do_not_discard_recoverable_text(self):
        self.session([])
        message = assistant("one", [{"type": "text", "text": "recoverable"}, {"type": "toolCall", "name": "bash"}])
        (self.directory / "stdout.jsonl").write_text(json.dumps({"type": "message_update", "message": message}) + "\n")
        document, accounting = self.export("cancelled")
        self.assertEqual(document["steps"][0]["message"], "recoverable")
        self.assertTrue(document["steps"][0]["extra"]["incomplete_tool_calls"])
        self.assertFalse(accounting["complete"])


if __name__ == "__main__":
    unittest.main()
