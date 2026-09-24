"""Deterministic native-stream outcomes, including zero-exit failure cases."""

import json
from pathlib import Path
import tempfile
import unittest

from harbor.agents.installed.base import AgentAuthenticationError

from diffex_terminal_bench.execution import SYSTEM_PROMPT_SHA256, USER_MESSAGE_SUFFIX
from diffex_terminal_bench.outcome import DiffexControlStopError, DiffexExecutionError, parse_outcome, require_completed


def attempt(reason="stop", error="", retry=False):
    message = {"role": "assistant", "content": [], "stopReason": reason, "errorMessage": error}
    return [{"type": "agent_start"}, {"type": "message_start", "message": message},
            {"type": "message_end", "message": message},
            {"type": "agent_end", "messages": [message], "willRetry": retry}]


def write_cleanup(directory):
    (directory / "stop-requested").touch()
    controls = [{"role": "launcher", "pid": 10, "start": "100"}, {"role": "cli", "pid": 11, "start": "101"}]
    for control in controls:
        (directory / f"{control['role']}.json").write_text(json.dumps({key: value for key, value in control.items() if key != "role"}))
    report = {"schema_version": 1, "phase": "pre-verifier", "stop_requested": True,
              "agent_execution_stopped": True, "ownership_validated": True,
              "remaining_agent_pids": [], "control_processes": controls, "retained_processes": [],
              "ownership_records": []}
    (directory / "cleanup.json").write_text(json.dumps(report))
    return report


def write_evidence(directory, events=None):
    directory.mkdir(parents=True, exist_ok=True)
    config = {"provider": "openai", "model": "gpt-5", "thinking": "high", "tools": ["bash"], "instruction_sha256": "fixture", "background_process_lifetime": "environment",
              "user_message_suffix": USER_MESSAGE_SUFFIX, "system_prompt_sha256": SYSTEM_PROMPT_SHA256}
    for name, content in {
        "requested.json": config,
        "effective.json": {**config, "context_files_disabled": True, "instruction_delivered": True},
        "process.json": {"exit_code": 0, "signal": None, "spawn_error": None},
    }.items():
        (directory / name).write_text(json.dumps(content))
    write_cleanup(directory)
    (directory / "stdout.jsonl").write_text("".join(json.dumps(event) + "\n" for event in
                                                   [{"type": "session"}, *(events if events is not None else attempt()), {"type": "agent_settled"}]))


def retain_service(directory):
    report = write_cleanup(directory)
    member = {"pid": 123, "processGroupId": 122, "startTime": "boot:456"}
    record = {"version": 1, "executionId": "service", "owner": "environment", "state": "background",
              "processGroupId": 122, "supervisorPid": 120, "members": [member]}
    (directory / "ownership").mkdir(exist_ok=True)
    (directory / "ownership/service.json").write_text(json.dumps(record))
    report.update(ownership_records=[record], retained_processes=[{**member, "executionId": "service", "owner": "environment"}])
    (directory / "cleanup.json").write_text(json.dumps(report))
    return report


class OutcomeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def outcome(self, events=None, **kwargs):
        write_evidence(self.directory, events)
        return parse_outcome(self.directory, launcher_exit_code=0, **kwargs)

    def test_completed_run_does_not_infer_verifier_reward(self):
        outcome = self.outcome()
        require_completed(outcome)
        self.assertEqual(outcome["status"], "completed")
        self.assertNotIn("reward", outcome)

    def test_zero_exit_cannot_hide_authentication_or_terminal_failure(self):
        for reason, error, status, exception in [
            ("error", "401 invalid API key", "authentication_failure", AgentAuthenticationError),
            ("error", "service overloaded", "provider_failure", DiffexExecutionError),
            ("aborted", "cancelled", "provider_failure", DiffexExecutionError),
        ]:
            with self.subTest(reason=reason, error=error):
                outcome = self.outcome(attempt(reason, error))
                self.assertEqual(outcome["status"], status)
                self.assertNotIn(error, json.dumps(outcome))
                with self.assertRaises(exception):
                    require_completed(outcome)

    def test_exhausted_and_recovered_retry(self):
        prefix = [*attempt("error", "503", retry=True), {"type": "auto_retry_start"}]
        for recovered in (False, True):
            events = [*prefix, *attempt("stop" if recovered else "error"),
                      {"type": "auto_retry_end", "success": recovered}]
            outcome = self.outcome(events)
            self.assertEqual(outcome["status"], "completed" if recovered else "provider_failure")
            self.assertEqual(outcome["retry_attempts"], 1)
            self.assertEqual(outcome["recovered_retries"], int(recovered))
        # Native success emits retry_end between message_end and agent_end.
        events = [*prefix, *attempt()[:-1], {"type": "auto_retry_end", "success": True}, attempt()[-1]]
        self.assertEqual(self.outcome(events)["status"], "completed")

    def test_incomplete_streams_never_complete(self):
        for events in ([], attempt()[:-1], attempt() + [{"type": "agent_start"}],
                       attempt() + [{"type": "auto_retry_start"}],
                       attempt("toolUse"), attempt("length"), attempt("pending"),
                       [attempt()[-1]], attempt() + [{"type": "message_update"}]):
            with self.subTest(events=events):
                self.assertNotEqual(self.outcome(events)["status"], "completed")
        for suffix in ('{"type":', '\n', '[]\n', '\ufffd\n'):
            write_evidence(self.directory)
            with (self.directory / "stdout.jsonl").open("a") as stream:
                stream.write(suffix)
            self.assertEqual(parse_outcome(self.directory, launcher_exit_code=0)["status"], "incomplete")
        write_evidence(self.directory)
        path = self.directory / "stdout.jsonl"
        path.write_text("\n".join(path.read_text().splitlines()[:-1]) + "\n")
        self.assertEqual(parse_outcome(self.directory, launcher_exit_code=0)["status"], "incomplete")

    def test_process_configuration_and_cleanup_are_required(self):
        for name, data, status in (
            ("process.json", {"exit_code": 1}, "process_failure"),
            ("process.json", {"exit_code": 0, "signal": "SIGTERM"}, "process_failure"),
            ("effective.json", {}, "configuration_failure"),
            ("cleanup.json", {"confirmed": False}, "cleanup_failure"),
        ):
            write_evidence(self.directory)
            (self.directory / name).write_text(json.dumps(data))
            self.assertEqual(parse_outcome(self.directory, launcher_exit_code=0)["status"], status)
        write_evidence(self.directory)
        self.assertEqual(parse_outcome(self.directory, launcher_exit_code=1)["status"], "process_failure")

    def test_interruption_preserves_partial_evidence(self):
        for interruption in ("cancelled", "timeout", "transport_failure"):
            outcome = self.outcome(attempt()[:-1], interruption=interruption)
            self.assertEqual(outcome["status"], interruption)
            self.assertFalse(outcome["stream_complete"])
            self.assertTrue((self.directory / "stdout.jsonl").is_file())

    def test_user_message_suffix_must_be_delivered_and_match_the_eval_policy(self):
        for field, value in (("user_message_suffix", ""), ("instruction_delivered", False)):
            write_evidence(self.directory)
            path = self.directory / "effective.json"
            effective = json.loads(path.read_text())
            effective[field] = value
            path.write_text(json.dumps(effective))
            self.assertEqual(parse_outcome(self.directory, launcher_exit_code=0)["status"], "configuration_failure")
        for name in ("requested.json", "effective.json"):
            path = self.directory / name
            data = json.loads(path.read_text())
            data.update(user_message_suffix="arbitrary task hint", instruction_delivered=True)
            path.write_text(json.dumps(data))
        self.assertEqual(parse_outcome(self.directory, launcher_exit_code=0)["status"], "configuration_failure")

    def test_system_prompt_must_match_and_context_files_must_be_disabled(self):
        for field, value in (("system_prompt_sha256", "changed"), ("context_files_disabled", False)):
            with self.subTest(field=field):
                write_evidence(self.directory)
                path = self.directory / "effective.json"
                effective = json.loads(path.read_text())
                effective[field] = value
                path.write_text(json.dumps(effective))
                self.assertEqual(parse_outcome(self.directory, launcher_exit_code=0)["status"], "configuration_failure")
        write_evidence(self.directory)
        for name in ("requested.json", "effective.json"):
            path = self.directory / name
            data = json.loads(path.read_text())
            data["system_prompt_sha256"] = "matching-but-unapproved-prompt"
            path.write_text(json.dumps(data))
        self.assertEqual(parse_outcome(self.directory, launcher_exit_code=0)["status"], "configuration_failure")

    def test_retained_service_does_not_change_execution_outcome(self):
        for interruption, code, status in ((None, 0, "completed"), (None, 1, "process_failure"),
                                            ("cancelled", None, "cancelled"), ("timeout", None, "timeout")):
            write_evidence(self.directory)
            report = retain_service(self.directory)
            outcome = parse_outcome(self.directory, interruption=interruption, launcher_exit_code=code)
            self.assertEqual(outcome["status"], status)
            self.assertTrue(outcome["agent_execution_stopped"])
            self.assertEqual(outcome["retained_processes"], report["retained_processes"])

    def test_missing_or_contradictory_evidence_blocks_verification(self):
        for key, value in (("agent_execution_stopped", False), ("ownership_validated", False),
                           ("remaining_agent_pids", [124]), ("ownership_records", []),
                           ("control_processes", []),
                           ("control_processes", [{"role": "cli", "pid": 123, "start": "456"}])):
            write_evidence(self.directory)
            report = retain_service(self.directory)
            report[key] = value
            (self.directory / "cleanup.json").write_text(json.dumps(report))
            for interruption in (None, "cancelled"):
                with self.subTest(key=key, interruption=interruption):
                    outcome = parse_outcome(self.directory, interruption, launcher_exit_code=0)
                    self.assertFalse(outcome["agent_execution_stopped"])
                    with self.assertRaises(DiffexControlStopError):
                        require_completed(outcome)
        write_evidence(self.directory)
        retain_service(self.directory)
        (self.directory / "ownership/service.json").unlink()
        self.assertEqual(parse_outcome(self.directory, launcher_exit_code=0)["status"], "cleanup_failure")


if __name__ == "__main__":
    unittest.main()
