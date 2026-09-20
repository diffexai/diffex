"""Standalone samples through the CLI, retained reports, and verification."""

from contextlib import ExitStack, redirect_stderr, redirect_stdout
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from diffex_terminal_bench.benchmark import PACKAGE, main
from diffex_terminal_bench.dataset import load_config
from diffex_terminal_bench.gate import fingerprint, read_json, sample_tasks, stage_tasks, write_json


class SamplingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "sample-run"
        self.config = load_config(PACKAGE / "benchmark.toml")
        names = self.config.pilot_tasks + [f"extra-{index:02d}" for index in range(79)]
        self.tasks = {name: Path(name) for name in names}
        self.identity = {"model": self.config.model, "policy": self.config.policy.model_dump(),
                         "dataset": self.config.dataset.model_dump(), "pilot_tasks": self.config.pilot_tasks,
                         "task_digests": {name: "sha256:fixture" for name in names}, "concurrency": 2}
        self.started = []
        self.cleaned = []
        self.fail_trial = False
        self.sample_count = 5

        async def create(config):
            # The complete selection must be durable before any remote work.
            gate = read_json(self.root / "sample/gate.json")
            self.assertEqual(gate["identity_sha256"], fingerprint(gate["identity"]))
            self.assertEqual(len(gate["identity"]["sample"]["tasks"]), self.sample_count)
            self.assertEqual(config.agent.model_name, self.config.model)
            self.assertEqual(config.agent.kwargs, self.config.policy.model_dump(
                include={"thinking", "tools", "subagents", "project_resources", "background_process_lifetime"}))
            self.assertEqual(config.timeout_multiplier, 1)
            self.assertTrue(config.environment.delete)
            self.started.append(config.task.path.name)
            if self.fail_trial and len(self.started) == 1:
                raise RuntimeError("fixture startup failure")
            return Mock(run=AsyncMock())

        async def cleanup(client, directory, label):
            self.cleaned.append(directory.name)
            report = {"confirmed": True, "unexpected_sandboxes": []}
            write_json(directory / "sandbox-cleanup.json", report)
            return report

        stack = self.enterContext(ExitStack())
        self.preflight = stack.enter_context(patch("diffex_terminal_bench.benchmark.preflight"))
        self.prepare = stack.enter_context(patch("diffex_terminal_bench.benchmark.prepare_dataset"))
        self.prepare.return_value.__enter__.return_value = (self.tasks, self.identity["task_digests"])
        stack.enter_context(patch("diffex_terminal_bench.benchmark.run_identity", side_effect=lambda *args: self.identity.copy()))
        stack.enter_context(patch("diffex_terminal_bench.benchmark.AsyncDaytona"))
        self.create = stack.enter_context(patch("diffex_terminal_bench.benchmark.Trial.create", side_effect=create))
        stack.enter_context(patch("diffex_terminal_bench.benchmark.Packager.compute_content_hash", return_value=("fixture", [])))
        stack.enter_context(patch("diffex_terminal_bench.benchmark.confirm_cleanup", side_effect=cleanup))
        stack.enter_context(patch("diffex_terminal_bench.benchmark.DaytonaClientManager.get_instance",
                                 return_value=Mock(_cleanup=AsyncMock())))
        stack.enter_context(patch("diffex_terminal_bench.benchmark.validate_trial", return_value={"rewards": {"reward": 0}}))

    def cli(self, *arguments):
        output = io.StringIO()
        with patch("sys.argv", ["benchmark", "--output", str(self.root), "-n", "2", *arguments]), \
             redirect_stdout(output), redirect_stderr(output):
            main()
        return output.getvalue()

    def test_sampling_is_distinct_reproducible_and_uses_the_full_population(self):
        selected = sample_tasks(list(self.tasks), 5, 42)
        self.assertEqual(len(set(selected)), 5)
        self.assertEqual(selected, sample_tasks(list(reversed(self.tasks)), 5, 42))
        self.assertNotEqual(selected, sample_tasks(list(self.tasks), 5, 43))
        self.assertTrue(set(selected) - set(self.config.pilot_tasks))
        self.assertEqual(set(sample_tasks(list(self.tasks), 89, 0)), set(self.tasks))
        for count in (0, -1, 90, True, 1.5):
            with self.subTest(count=count), self.assertRaises(ValueError):
                sample_tasks(list(self.tasks), count, 42)

    def test_cli_runs_exactly_five_without_prerequisites_and_verifies_saved_selection(self):
        output = self.cli("--sample", "5", "--seed", "0")
        selected = sample_tasks(list(self.tasks), 5, 0)
        self.assertEqual(self.started, selected)
        self.assertEqual(len(self.cleaned), 5)
        self.assertIn("Sample seed: 0", output)
        gate = read_json(self.root / "sample/gate.json")
        self.assertTrue(gate["passed"])
        self.assertEqual(gate["completed_trials"], 5)
        self.assertEqual(gate["identity"]["sample"], {"count": 5, "seed": 0, "tasks": selected})
        self.assertFalse((self.root / "oracle").exists())
        self.assertIn("sample-run/sample/gate.json", (self.root.parent / "index.md").read_text())
        self.preflight.reset_mock()
        self.create.reset_mock()
        with patch("diffex_terminal_bench.gate.validate_trial") as validate:
            self.assertIn("Verified retained sample evidence", self.cli("--verify-sample"))
        self.assertEqual([call.args[1] for call in validate.call_args_list], selected)
        self.preflight.assert_not_called()
        self.create.assert_not_called()
        with self.assertRaises(FileExistsError):
            self.cli("--sample", "5", "--seed", "0")
        self.create.assert_not_called()
        with self.assertRaises(OSError):
            self.cli("--stage", "full")
        self.create.assert_not_called()

    def test_generated_seed_is_retained_and_replayable(self):
        with patch("diffex_terminal_bench.benchmark.secrets.randbits", return_value=123456):
            self.cli("--sample", "5")
        gate = read_json(self.root / "sample/gate.json")
        self.assertEqual(gate["identity"]["sample"]["seed"], 123456)
        self.assertEqual(self.started, sample_tasks(list(self.tasks), 5, 123456))

    def test_single_random_task_runs_once_and_verifies_without_prerequisites(self):
        self.sample_count = 1
        with patch("diffex_terminal_bench.benchmark.secrets.randbits", return_value=42):
            self.cli("--random")
        selected = sample_tasks(list(self.tasks), 1, 42)
        self.assertEqual(self.started, selected)
        self.assertEqual(len(self.cleaned), 1)
        gate = read_json(self.root / "sample/gate.json")
        self.assertTrue(gate["passed"])
        self.assertEqual(gate["expected_trials"], 1)
        self.assertEqual(gate["completed_trials"], 1)
        self.assertEqual(gate["identity"]["sample"], {"count": 1, "seed": 42, "tasks": selected})
        self.assertFalse((self.root / "oracle").exists())
        self.create.reset_mock()
        with patch("diffex_terminal_bench.gate.validate_trial") as validate:
            self.cli("--verify-sample")
        self.assertEqual([call.args[1] for call in validate.call_args_list], selected)
        self.create.assert_not_called()

    def test_random_seed_replays_single_task_and_preserves_explicit_output(self):
        self.sample_count = 1
        output = self.cli("--random", "--seed", "0")
        self.assertEqual(self.started, sample_tasks(list(self.tasks), 1, 0))
        self.assertIn(f"Sample output: {self.root.resolve()}", output)
        with self.assertRaises(FileExistsError):
            self.cli("--random", "--seed", "0")
        self.assertEqual(len(self.started), 1)

    def test_random_defaults_to_unique_output_directories(self):
        with patch("diffex_terminal_bench.benchmark.execute", new_callable=AsyncMock) as execute:
            for _ in range(2):
                with patch("sys.argv", ["benchmark", "--random"]), redirect_stdout(io.StringIO()):
                    main()
        roots = [call.args[3] for call in execute.call_args_list]
        self.assertEqual(len(roots), 2)
        self.assertNotEqual(roots[0], roots[1])
        for call in execute.call_args_list:
            self.assertEqual(call.args[3].parent, PACKAGE / "results")
            self.assertTrue(call.args[3].name.startswith("sample-tb21-"))
            self.assertEqual(call.args[2]["sample"]["count"], 1)
            self.assertEqual(call.args[4:], ("sample", False))
        self.create.assert_not_called()

    def test_failed_sample_finishes_remaining_tasks_and_cannot_verify(self):
        self.fail_trial = True
        with self.assertRaisesRegex(SystemExit, "completed 5 trials with 1 failed"):
            self.cli("--sample", "5", "--seed", "42")
        self.assertEqual(len(self.started), 5)
        self.assertEqual(len(self.cleaned), 5)
        self.prepare.reset_mock()
        with self.assertRaisesRegex(SystemExit, "recorded run did not pass.*--allow-partial") as error:
            self.cli("--verify-sample")
        self.assertTrue(error.exception.__suppress_context__)
        self.prepare.assert_not_called()

    def test_verification_rejects_selection_and_evidence_tampering(self):
        self.cli("--sample", "5", "--seed", "42")
        path = self.root / "sample/gate.json"
        original = path.read_bytes()
        gate = read_json(path)
        gate["identity"]["sample"]["tasks"].reverse()
        gate["identity_sha256"] = fingerprint(gate["identity"])
        write_json(path, gate)
        with self.assertRaisesRegex(SystemExit, "recorded seed"):
            self.cli("--verify-sample")
        path.write_bytes(original)
        trial = self.root / "sample" / read_json(path)["trials"][0]["directory"]
        (trial / "sandbox-cleanup.json").unlink()
        with self.assertRaisesRegex(SystemExit, "evidence changed"):
            self.cli("--verify-sample")

    def test_failed_sample_cli_explains_timeout_without_traceback_or_dataset_access(self):
        report = {"passed": False, "finished_at": "2026-09-16T23:34:06Z", "completed_trials": 5, "expected_trials": 5,
                  "failure": {"directory": "003-extract-moves-from-video", "diagnostics": {
                      "harbor_exception": "AgentTimeoutError", "agent_timeout_sec": 1800,
                      "retry_attempts": 0, "rate_limit_retries": 0, "retry_evidence_complete": True}}}
        path = self.root / "sample/gate.json"
        write_json(path, report)
        before = path.read_bytes()
        cache = self.root / "unused-cache"
        result = subprocess.run([sys.executable, "-m", "diffex_terminal_bench.benchmark", "--verify-sample",
                                 "--output", str(self.root), "--dataset-cache", str(cache)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn("5/5 trials completed", result.stderr)
        self.assertIn("003-extract-moves-from-video: AgentTimeoutError at the 1800s task deadline", result.stderr)
        self.assertIn("--allow-partial", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("missing qualification", result.stderr)
        self.assertFalse(cache.exists())
        self.assertEqual(path.read_bytes(), before)

    def test_missing_corrupt_and_unfinished_sample_reports_exit_cleanly(self):
        path = self.root / "sample/gate.json"
        with self.assertRaisesRegex(SystemExit, "Sample verification failed"):
            self.cli("--verify-sample")
        write_json(path, {"passed": False})
        with self.assertRaisesRegex(SystemExit, "no final report"):
            self.cli("--verify-sample")
        path.write_text("{")
        with self.assertRaisesRegex(SystemExit, "Sample verification failed"):
            self.cli("--verify-sample")
        self.prepare.assert_not_called()
        self.preflight.assert_not_called()
        self.create.assert_not_called()

    def test_invalid_flags_fail_before_dataset_or_remote_work(self):
        cases = [("--sample", "0"), ("--sample", "-1"), ("--sample", "90"), ("--sample", "1.5"),
                 ("--stage", "pilot", "--seed", "42"), ("--sample", "5", "--through", "integration"),
                 ("--verify-sample", "--seed", "42"), ("--random", "--sample", "5"),
                 ("--random", "--through", "integration"), ("--random", "--verify-sample")]
        for arguments in cases:
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit) as error:
                self.cli(*arguments)
            self.assertEqual(error.exception.code, 2)
        self.prepare.assert_not_called()
        self.preflight.assert_not_called()
        self.create.assert_not_called()

    def test_sample_plan_requires_recorded_seed_count_and_tasks(self):
        for selection in (None, {}, {"count": 5, "seed": True, "tasks": []},
                          {"count": 5, "seed": 42, "tasks": ["missing"] * 5}):
            with self.subTest(selection=selection), self.assertRaises(ValueError):
                stage_tasks("sample", self.config.pilot_tasks, list(self.tasks), sample=selection)


if __name__ == "__main__":
    unittest.main()
