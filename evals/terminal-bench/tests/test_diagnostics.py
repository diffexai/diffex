"""Replay a timed-out Harbor trial through the offline CLI and live-stage gate."""

from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from diffex_terminal_bench.benchmark import StageFailedError, main
from diffex_terminal_bench.diagnostics import TrialExecutionFailure, describe_failure, diagnose_trial
from diffex_terminal_bench.gate import validate_trial, write_json


class FailureDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name) / "007-build-cython-ext"
        self.result = {"finished_at": "2026-09-15T18:22:36Z", "exception_info": {
            "exception_type": "AgentTimeoutError", "exception_message": "Agent execution timed out after 900.0 seconds",
            "exception_traceback": "private traceback"}, "verifier_result": {"rewards": {"reward": 1.0}}}
        write_json(self.directory / "result.json", self.result)
        self.stream = self.directory / "agent/run-fixture/stdout.jsonl"
        self.stream.parent.mkdir(parents=True)
        events = [{"type": "auto_retry_start", "errorMessage": "Rate limit reached for private-org. secret-token",
                   "delayMs": 2000}, {"type": "auto_retry_start", "errorMessage": "HTTP 429", "delayMs": 4000},
                  {"type": "auto_retry_start", "errorMessage": "Network error", "delayMs": 2000}]
        self.stream.write_text("".join(json.dumps(event) + "\n" for event in events))

    def test_timeout_with_full_reward_is_rejected_with_safe_cause(self):
        with self.assertRaises(TrialExecutionFailure) as error:
            validate_trial(self.directory, "build-cython-ext", {})
        self.assertIn("AgentTimeoutError at the 900s task deadline", str(error.exception))
        self.assertIn("3 scheduled retries (2 rate-limit retries, 8s scheduled backoff)", str(error.exception))
        self.assertNotIn("private", str(error.exception))
        self.assertNotIn("secret", json.dumps(error.exception.details))

    def test_offline_cli_explains_old_trials_without_identity_or_provider(self):
        output = io.StringIO()
        with patch("sys.argv", ["benchmark", "--diagnose-trial", str(self.directory)]), \
             patch("diffex_terminal_bench.benchmark.preflight") as preflight, \
             patch("diffex_terminal_bench.benchmark.prepare_dataset") as prepare, \
             patch("diffex_terminal_bench.benchmark.run_identity") as identity, redirect_stdout(output):
            main()
        self.assertIn("007-build-cython-ext: AgentTimeoutError", output.getvalue())
        self.assertIn(str(self.directory), output.getvalue())
        preflight.assert_not_called()
        prepare.assert_not_called()
        identity.assert_not_called()

    def test_truncated_evidence_retains_observed_retry_counts(self):
        with self.stream.open("a") as output:
            output.write('{"type":')
        details = diagnose_trial(self.directory)
        self.assertFalse(details["retry_evidence_complete"])
        self.assertEqual(details["retry_attempts"], 3)

    def test_missing_stream_is_unknown_and_raw_exception_text_is_not_reported(self):
        self.stream.unlink()
        self.result["exception_info"] = {"exception_type": "secret\nprovider text", "exception_message": "secret"}
        details = diagnose_trial(self.directory, self.result)
        self.assertFalse(details["retry_evidence_complete"])
        self.assertIsNone(details["harbor_exception"])
        self.assertNotIn("secret", describe_failure(details))

    def test_expected_cli_stage_failure_exits_nonzero_without_traceback(self):
        with patch("sys.argv", ["benchmark", "--stage", "pilot", "--output", str(self.directory)]), \
             patch("diffex_terminal_bench.benchmark.preflight"), \
             patch("diffex_terminal_bench.benchmark.prepare_dataset") as prepare, \
             patch("diffex_terminal_bench.benchmark.run_identity", return_value={}), \
             patch("diffex_terminal_bench.benchmark.execute", side_effect=StageFailedError("pilot: AgentTimeoutError")):
            prepare.return_value.__enter__.return_value = ({}, {})
            with self.assertRaises(SystemExit) as error:
                main()
        self.assertEqual(error.exception.code, "pilot: AgentTimeoutError")
        self.assertTrue(error.exception.__suppress_context__)


if __name__ == "__main__":
    unittest.main()
