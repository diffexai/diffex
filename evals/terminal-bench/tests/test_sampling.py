"""Standalone samples through the CLI, retained reports, and verification."""

from contextlib import ExitStack, redirect_stderr, redirect_stdout
import io
from pathlib import Path
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

        async def create(config):
            # The complete selection must be durable before any remote work.
            gate = read_json(self.root / "sample/gate.json")
            self.assertEqual(gate["identity_sha256"], fingerprint(gate["identity"]))
            self.assertEqual(len(gate["identity"]["sample"]["tasks"]), 5)
            self.assertEqual(config.agent.model_name, self.config.model)
            self.assertEqual(config.agent.kwargs, self.config.policy.model_dump(
                include={"thinking", "tools", "subagents", "project_resources"}))
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

    def test_failed_sample_finishes_remaining_tasks_and_cannot_verify(self):
        self.fail_trial = True
        with self.assertRaisesRegex(SystemExit, "completed 5 trials with 1 failed"):
            self.cli("--sample", "5", "--seed", "42")
        self.assertEqual(len(self.started), 5)
        self.assertEqual(len(self.cleaned), 5)
        with self.assertRaisesRegex(ValueError, "missing qualification"):
            self.cli("--verify-sample")

    def test_verification_rejects_selection_and_evidence_tampering(self):
        self.cli("--sample", "5", "--seed", "42")
        path = self.root / "sample/gate.json"
        original = path.read_bytes()
        gate = read_json(path)
        gate["identity"]["sample"]["tasks"].reverse()
        gate["identity_sha256"] = fingerprint(gate["identity"])
        write_json(path, gate)
        with self.assertRaisesRegex(ValueError, "recorded seed"):
            self.cli("--verify-sample")
        path.write_bytes(original)
        trial = self.root / "sample" / read_json(path)["trials"][0]["directory"]
        (trial / "sandbox-cleanup.json").unlink()
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            self.cli("--verify-sample")

    def test_invalid_flags_fail_before_dataset_or_remote_work(self):
        cases = [("--sample", "0"), ("--sample", "-1"), ("--sample", "90"), ("--sample", "1.5"),
                 ("--stage", "pilot", "--seed", "42"), ("--sample", "5", "--through", "integration"),
                 ("--verify-sample", "--seed", "42")]
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
