"""Gate regressions exercise real native parsing and ATIF conversion."""

import asyncio
import copy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from harbor.models.agent.context import AgentContext
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig

from diffex_terminal_bench.benchmark import PACKAGE, main, run_stage
from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.dataset import BenchmarkConfig, load_config
from diffex_terminal_bench.execution import ExecutionOptions, SUBAGENT_TOOLS, SYSTEM_PROMPT, SYSTEM_PROMPT_SHA256, USER_MESSAGE_SUFFIX
from diffex_terminal_bench.gate import inventory, require_previous, sha256, stage_tasks, validate_trial, write_json
from diffex_terminal_bench.outcome import parse_outcome
from diffex_terminal_bench.trajectory import export_trajectory
from test_outcome import retain_service, write_cleanup
from test_trajectory import USAGE, assistant, entry, failed_child_records, interrupted_child_records


class GateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.directory = self.root / "oracle" / "task-1"
        self.run = self.directory / "agent/run-fixture"
        self.run.mkdir(parents=True)
        self.identity = {"model": "openai/gpt-5", "policy": {"thinking": "high", "tools": "bash",
                         "subagents": "disabled", "project_resources": "context-only", "background_process_lifetime": "environment"},
                         "system_prompt_sha256": SYSTEM_PROMPT_SHA256, "task_digests": {"task": "sha256:task"}}
        requested = {"provider": "openai", "model": "gpt-5", "thinking": "high", "tools": ["bash"],
                     "subagents": "disabled", "project_resources": "context-only", "background_process_lifetime": "environment", "pins": PINS,
                     "evolution": {"enabled": False}, "state_policy": "fresh-per-run", "user_message_suffix": USER_MESSAGE_SUFFIX,
                     "system_prompt_sha256": SYSTEM_PROMPT_SHA256}
        (self.run / "instruction.txt").write_text("task")
        (self.run / "system-prompt.txt").write_text(SYSTEM_PROMPT)
        requested["instruction_sha256"] = sha256(self.run / "instruction.txt")
        write_json(self.run / "requested.json", requested)
        write_json(self.run / "effective.json", {**requested, "context_files_disabled": True, "instruction_delivered": True})
        write_json(self.run / "process.json", {"exit_code": 0})
        write_cleanup(self.run)
        message = assistant("response")
        events = [{"type": "session"}, {"type": "agent_start"}, {"type": "message_start", "message": message},
                  {"type": "message_end", "message": message}, {"type": "agent_end", "messages": [message]},
                  {"type": "agent_settled"}]
        (self.run / "stdout.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
        (self.run / "sessions").mkdir()
        records = [{"type": "session", "id": "root"}, entry("one", message)]
        (self.run / "sessions/root.jsonl").write_text("".join(json.dumps(record) + "\n" for record in records))
        outcome = parse_outcome(self.run, launcher_exit_code=0)
        write_json(self.run / "outcome.json", outcome)
        context = AgentContext()
        export_trajectory(self.run, self.directory / "agent/trajectory.json", context, outcome)
        for name in ("stderr.log", "launcher.stdout.log", "launcher.stderr.log"):
            (self.run / name).touch()
        setup = self.directory / "agent/setup"
        write_json(setup / "installation.json", {"verified": True, "harbor_version": PINS["harbor_version"],
                   "background_process_lifetime": "environment",
                   "node_version": f"v{PINS['node_version']}", "diffex_version": PINS["diffex_version"],
                   "npm_integrity": PINS["diffex_integrity"], "npm_registry": PINS["npm_registry"], "elapsed_sec": 10})
        for name in ("version", "help", "list-models"):
            (setup / f"{name}.stdout.txt").write_text("ok")
            (setup / f"{name}.stderr.txt").touch()
        config = TrialConfig(task=TaskConfig(path=Path("/task")),
            agent=AgentConfig(import_path="diffex_terminal_bench.adapter:DiffexAgent", model_name="openai/gpt-5",
                              override_setup_timeout_sec=630, kwargs=self.identity["policy"], env={"OPENAI_API_KEY": "${OPENAI_API_KEY}"}),
            environment=EnvironmentConfig(import_path="diffex_terminal_bench.daytona_backend:RecordedDaytonaEnvironment",
                                          kwargs={"labels": {"diffex.gate_trial": "unique"}}))
        write_json(self.directory / "config.json", config.model_dump(mode="json"))
        write_json(self.directory / "lock.json", {**config.model_dump(mode="json", exclude_none=True), "task": {"digest": "sha256:task"}})
        write_json(self.directory / "cleanup-request.json", {"label": "unique"})
        write_json(self.directory / "sandbox-created.json", {"sandboxes": [{"id": "sandbox"}]})
        write_json(self.directory / "sandbox-cleanup.json", {"confirmed": True, "unexpected_sandboxes": []})
        write_json(self.directory / "result.json", {"finished_at": "2026-09-15T00:00:00Z",
                   "verifier_result": {"rewards": {"reward": 0}}, "agent_result": context.model_dump(mode="json")})
        verifier = self.directory / "verifier"
        verifier.mkdir()
        (verifier / "reward.txt").write_text("0")
        (verifier / "test-stdout.txt").write_text("task failed")

    def mutate(self, path, key, value):
        data = json.loads(path.read_text())
        data[key] = value
        write_json(path, data)

    def write_interrupted_child(self, *, records=None, **options):
        self.identity["policy"]["subagents"] = "enabled"
        for name in ("requested.json", "effective.json"):
            self.mutate(self.run / name, "subagents", "enabled")
            self.mutate(self.run / name, "tools", ["bash", *SUBAGENT_TOOLS])
        for name in ("config.json", "lock.json"):
            document = json.loads((self.directory / name).read_text())
            document["agent"]["kwargs"] = self.identity["policy"].copy()
            write_json(self.directory / name, document)
        root, child = records if records is not None else interrupted_child_records(**options)
        # Keep the final root response identical to the completed stdout stream.
        root[-1] = entry("one", assistant("response"))
        for name, records in (("root", root), ("child", child)):
            path = self.run / "sessions" / ("root.jsonl" if name == "root" else ".subagents/child.jsonl")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("".join(json.dumps(record) + "\n" for record in [{"type": "session", "id": name}, *records]))
        self.reexport()

    def reexport(self):
        context = AgentContext()
        export_trajectory(self.run, self.directory / "agent/trajectory.json", context,
                          json.loads((self.run / "outcome.json").read_text()))
        self.mutate(self.directory / "result.json", "agent_result", context.model_dump(mode="json"))

    def test_intentional_interruption_passes_with_partial_usage_and_zero_reward(self):
        self.write_interrupted_child()
        report = validate_trial(self.directory, "task", self.identity)
        self.assertEqual(report["rewards"], {"reward": 0})
        self.assertEqual(report["usage"]["prompt_tokens"], 76)
        self.assertFalse(report["usage_complete"])
        self.assertEqual(report["usage_missing_fields"], ["cached_tokens", "completion_tokens", "cost_usd", "prompt_tokens"])

    def test_recorded_child_failure_passes_with_zero_reward_and_partial_usage(self):
        self.write_interrupted_child(records=failed_child_records())
        report = validate_trial(self.directory, "task", self.identity)
        self.assertEqual(report["rewards"], {"reward": 0})
        self.assertEqual(report["usage"]["prompt_tokens"], 57)
        self.assertFalse(report["usage_complete"])
        self.mutate(self.directory / "sandbox-cleanup.json", "confirmed", False)
        with self.assertRaisesRegex(ValueError, "Sandbox cleanup"):
            validate_trial(self.directory, "task", self.identity)
        self.mutate(self.directory / "sandbox-cleanup.json", "confirmed", True)
        self.mutate(self.run / "process.json", "exit_code", 1)
        with self.assertRaisesRegex(ValueError, "Native execution evidence"):
            validate_trial(self.directory, "task", self.identity)

    def test_partial_accounting_still_rejects_corruption_and_execution_errors(self):
        cases = [{"status": "running"}, {"interrupt_error": True}, {"stop_reason": "error"},
                 {"usage": {**USAGE, "input": -1}}, {"usage": {**USAGE, "cost": {"total": "invalid"}}}]
        for options in cases:
            with self.subTest(options=options):
                self.write_interrupted_child(**options)
                with self.assertRaisesRegex(ValueError, "Native evidence is incomplete"):
                    validate_trial(self.directory, "task", self.identity)
        self.write_interrupted_child()
        child = self.run / "sessions/.subagents/child.jsonl"
        child.write_text(child.read_text() + '{"type":\n')
        self.reexport()
        with self.assertRaisesRegex(ValueError, "invalid_record"):
            validate_trial(self.directory, "task", self.identity)
        child.unlink()
        self.reexport()
        with self.assertRaisesRegex(ValueError, "missing_child_trajectory"):
            validate_trial(self.directory, "task", self.identity)

    def test_abort_error_requires_a_successful_intentional_interrupt(self):
        abort = {"stop_reason": "error", "error_message": "This operation was aborted"}
        self.write_interrupted_child(**abort)
        report = validate_trial(self.directory, "task", self.identity)
        self.assertEqual(report["usage"]["prompt_tokens"], 76)
        for options in ({"status": "running"}, {"interrupt_error": True},
                        {"error_message": "Provider connection failed"}):
            with self.subTest(options=options):
                self.write_interrupted_child(**{**abort, **options})
                with self.assertRaisesRegex(ValueError, "child_execution_incomplete"):
                    validate_trial(self.directory, "task", self.identity)

    def test_partial_accounting_and_harbor_totals_must_still_reconcile(self):
        self.write_interrupted_child()
        result_path = self.directory / "result.json"
        original = result_path.read_bytes()
        for field in ("n_input_tokens", "n_output_tokens", "n_cache_tokens", "cost_usd", "model_usage"):
            result = json.loads(original)
            result["agent_result"][field] = None
            write_json(result_path, result)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "usage differs"):
                validate_trial(self.directory, "task", self.identity)
        result = json.loads(original)
        result["agent_result"]["metadata"]["diffex_accounting"]["complete"] = True
        write_json(result_path, result)
        with self.assertRaisesRegex(ValueError, "accounting metadata differs"):
            validate_trial(self.directory, "task", self.identity)
        result_path.write_bytes(original)
        self.mutate(self.run / "accounting.json", "complete", True)
        with self.assertRaisesRegex(ValueError, "does not reconcile"):
            validate_trial(self.directory, "task", self.identity)

    def test_stage_continues_after_partial_usage_with_real_gate_validation(self):
        self.write_interrupted_child()
        cache = self.run / "state/home/.cache/huggingface/hub/model"
        (cache / "blobs").mkdir(parents=True)
        (cache / "blobs/weights").write_bytes(b"weights")
        (cache / "snapshots/revision").mkdir(parents=True)
        (cache / "snapshots/revision/model.safetensors").symlink_to("../../blobs/weights")
        pilot = ["task", *[f"task-{index}" for index in range(2, 11)]]
        identity = {**self.identity, "task_digests": {name: "sha256:task" for name in pilot}}
        # Exercise retained child accounting without launching agents. New
        # evaluations reject this older enabled-subagent execution policy.
        config = BenchmarkConfig.model_validate({**load_config(PACKAGE / "benchmark.toml").model_dump(),
                                                "model": "openai/gpt-5",
                                                "pilot_tasks": pilot, "concurrency": 1})
        config.policy = ExecutionOptions.model_construct(**self.identity["policy"])
        calls = []

        async def create(config):
            calls.append(config.trial_name)
            destination = config.trials_dir / config.trial_name
            shutil.copytree(self.directory, destination, dirs_exist_ok=True, symlinks=True)
            return Mock(run=AsyncMock())

        manager = Mock(_cleanup=AsyncMock())
        with patch("diffex_terminal_bench.benchmark.require_previous"), \
             patch("diffex_terminal_bench.benchmark.AsyncDaytona"), \
             patch("diffex_terminal_bench.benchmark.Trial.create", side_effect=create), \
             patch("diffex_terminal_bench.benchmark.Packager.compute_content_hash", return_value=("task", [])), \
             patch("diffex_terminal_bench.benchmark.confirm_cleanup", new_callable=AsyncMock,
                   return_value={"confirmed": True, "unexpected_sandboxes": []}), \
             patch("diffex_terminal_bench.benchmark.DaytonaClientManager.get_instance", new_callable=AsyncMock, return_value=manager):
            asyncio.run(run_stage(config, {name: Path(name) for name in pilot}, identity, self.root / "stages", "pilot"))
        report = json.loads((self.root / "stages/pilot/gate.json").read_text())
        self.assertTrue(report["passed"])
        self.assertEqual(len(calls), 10)
        self.assertEqual([trial["task"] for trial in report["trials"]], pilot)
        for trial in report["trials"]:
            self.assertTrue(any(value.startswith("symlink:") for value in trial["files"].values()))
            self.assertEqual(trial["evidence"]["rewards"], {"reward": 0})
            self.assertFalse(trial["evidence"]["usage_complete"])
            self.assertEqual(trial["evidence"]["usage"]["prompt_tokens"], 76)

    def test_cli_finishes_stage_after_execution_evidence_and_cleanup_failures(self):
        pilot = ["task", *[f"task-{index}" for index in range(2, 11)]]
        config = BenchmarkConfig.model_validate({**load_config(PACKAGE / "benchmark.toml").model_dump(),
                                                "model": "openai/gpt-5", "policy": self.identity["policy"],
                                                "pilot_tasks": pilot, "concurrency": 3})
        identity = {**self.identity, "task_digests": {name: "sha256:task" for name in pilot},
                    "dataset": config.dataset.model_dump()}
        started, cleaned = [], []
        output = io.StringIO()
        root = self.root / "stages"

        async def create(config):
            index = int(config.trial_name.split("-", 1)[0])
            started.append(index)
            destination = config.trials_dir / config.trial_name
            for path in self.directory.rglob("*"):
                if path.is_file():
                    target = destination / path.relative_to(self.directory)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(path.read_bytes())
            if index == 2:
                self.mutate(destination / "result.json", "exception_info", {
                    "exception_type": "AgentTimeoutError",
                    "exception_message": "Agent execution timed out after 900.0 seconds"})
            elif index == 3:
                (destination / "agent/run-fixture/stderr.log").unlink()
            elif index == 4:
                (destination / "result.json").write_text("{")
            elif index == 5:
                self.mutate(destination / "agent/run-fixture/process.json", "exit_code", 1)
            elif index == 7:
                raise RuntimeError("private provider error")
            return Mock(run=AsyncMock())

        async def cleanup(client, directory, label):
            index = int(directory.name.split("-", 1)[0])
            cleaned.append(index)
            report = {"confirmed": index != 6, "unexpected_sandboxes": []}
            write_json(directory / "sandbox-cleanup.json", report)
            return report

        manager = Mock(_cleanup=AsyncMock())
        with patch("sys.argv", ["benchmark", "--stage", "pilot", "--output", str(root)]), \
             patch("diffex_terminal_bench.benchmark.load_config", return_value=config), \
             patch("diffex_terminal_bench.benchmark.preflight"), \
             patch("diffex_terminal_bench.benchmark.prepare_dataset") as prepare, \
             patch("diffex_terminal_bench.benchmark.run_identity", return_value=identity), \
             patch("diffex_terminal_bench.benchmark.require_previous"), \
             patch("diffex_terminal_bench.benchmark.AsyncDaytona"), \
             patch("diffex_terminal_bench.benchmark.Trial.create", side_effect=create), \
             patch("diffex_terminal_bench.benchmark.Packager.compute_content_hash", return_value=("task", [])), \
             patch("diffex_terminal_bench.benchmark.confirm_cleanup", side_effect=cleanup), \
             patch("diffex_terminal_bench.benchmark.DaytonaClientManager.get_instance", return_value=manager), \
             redirect_stdout(output):
            prepare.return_value.__enter__.return_value = ({name: Path(name) for name in pilot}, identity["task_digests"])
            with self.assertRaises(SystemExit) as error:
                main()
        report = json.loads((root / "pilot/gate.json").read_text())
        self.assertEqual(started, list(range(1, 11)))
        self.assertEqual(sorted(cleaned), started)
        self.assertEqual(report["completed_trials"], 10)
        self.assertFalse(report["passed"])
        self.assertIn("finished_at", report)
        self.assertEqual([row["trial_index"] for row in report["failures"]], list(range(2, 8)))
        self.assertEqual(len(report["trials"]), 4)
        self.assertTrue(all(row["evidence"]["rewards"] == {"reward": 0} for row in report["trials"]))
        self.assertIn("completed 10 trials with 6 failed", str(error.exception.code))
        self.assertTrue(error.exception.__suppress_context__)
        self.assertNotIn("private provider error", output.getvalue() + json.dumps(report))
        self.assertEqual((root / "pilot/004-task-4/result.json").read_text(), "{")
        self.assertIn("failed; 10/10 completed; 4 checked; 6 failed", (self.root / "index.md").read_text())
        manager._cleanup.assert_awaited_once()

    def test_zero_reward_is_valid_benchmark_result(self):
        report = validate_trial(self.directory, "task", self.identity)
        self.assertEqual(report["rewards"], {"reward": 0})
        self.assertEqual(report["usage"]["prompt_tokens"], 19)

    def test_service_handoff_qualifies_and_corrupt_ownership_cannot(self):
        retain_service(self.run)
        write_json(self.run / "outcome.json", parse_outcome(self.run, launcher_exit_code=0))
        self.reexport()
        self.assertEqual(validate_trial(self.directory, "task", self.identity)["rewards"], {"reward": 0})
        self.mutate(self.run / "outcome.json", "retained_processes", [])
        with self.assertRaisesRegex(ValueError, "ownership evidence"):
            validate_trial(self.directory, "task", self.identity)
        self.mutate(self.run / "ownership/service.json", "owner", "session")
        with self.assertRaisesRegex(ValueError, "Native execution evidence"):
            validate_trial(self.directory, "task", self.identity)

    def test_missing_logs_and_forged_success_cannot_qualify(self):
        cases = [("agent/run-fixture/stderr.log", None, None),
                 ("agent/run-fixture/process.json", "exit_code", 1),
                 ("agent/run-fixture/accounting.json", "complete", False),
                 ("sandbox-cleanup.json", "confirmed", False),
                 ("sandbox-cleanup.json", "unexpected_sandboxes", ["leaked"]),
                 ("result.json", "exception_info", {"exception_type": "AgentAuthenticationError"}),
                 ("agent/setup/installation.json", "npm_integrity", "wrong")]
        for name, key, value in cases:
            with self.subTest(name=name, key=key):
                path = self.directory / name
                original = path.read_bytes()
                if key is None:
                    path.unlink()
                else:
                    self.mutate(path, key, value)
                with self.assertRaises((ValueError, OSError)):
                    validate_trial(self.directory, "task", self.identity)
                path.write_bytes(original)

    def test_model_and_harness_changes_invalidate_evidence(self):
        for key, value in (("model", "openai/gpt-4"), ("system_prompt_sha256", "changed")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_trial(self.directory, "task", {**self.identity, key: value})

    def test_reward_and_usage_must_reconcile(self):
        result = json.loads((self.directory / "result.json").read_text())
        for field in ("n_input_tokens", "n_output_tokens", "n_cache_tokens", "cost_usd", "model_usage"):
            modified = copy.deepcopy(result)
            modified["agent_result"][field] = None
            write_json(self.directory / "result.json", modified)
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_trial(self.directory, "task", self.identity)
        write_json(self.directory / "result.json", result)
        (self.directory / "verifier/reward.txt").write_text("1")
        with self.assertRaisesRegex(ValueError, "reward"):
            validate_trial(self.directory, "task", self.identity)

    def test_tampered_trajectory_fails_even_when_schema_is_valid(self):
        path = self.directory / "agent/trajectory.json"
        data = json.loads(path.read_text())
        data["steps"][-1]["message"] = "fabricated"
        write_json(path, data)
        with self.assertRaisesRegex(ValueError, "ATIF differs"):
            validate_trial(self.directory, "task", self.identity)

    def test_previous_stage_is_bound_to_configuration_and_retained_files(self):
        pilot = ["task", *[f"task-{i}" for i in range(9)]]
        result = json.loads((self.directory / "result.json").read_text())
        result["verifier_result"]["rewards"]["reward"] = 1
        write_json(self.directory / "result.json", result)
        (self.directory / "verifier/reward.txt").write_text("1")
        (self.directory / "agent/oracle.txt").write_text("oracle")
        for name in ("config.json", "lock.json"):
            self.mutate(self.directory / name, "agent", AgentConfig(name="oracle").model_dump(mode="json", exclude_none=True))
        report = {"passed": True, "identity": self.identity, "trials": [
            {"task": "task", "directory": "task-1", "files": inventory(self.directory)}]}
        write_json(self.directory.parent / "gate.json", report)
        require_previous(self.root, "trial", self.identity, pilot, pilot)
        with self.assertRaises(ValueError):
            require_previous(self.root, "trial", {**self.identity, "model": "changed"}, pilot, pilot)
        (self.directory / "verifier/test-stdout.txt").unlink()
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            require_previous(self.root, "trial", self.identity, pilot, pilot)

    def test_timeout_and_resource_overrides_cannot_qualify(self):
        path = self.directory / "config.json"
        original = path.read_bytes()
        for field, value in (("timeout_multiplier", 2), ("extra_instructions", ["task hint"])):
            self.mutate(path, field, value)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "configuration changed"):
                validate_trial(self.directory, "task", self.identity)
            path.write_bytes(original)
        config = json.loads(original)
        config["environment"]["override_cpus"] = 8
        write_json(path, config)
        with self.assertRaisesRegex(ValueError, "configuration changed"):
            validate_trial(self.directory, "task", self.identity)

    def test_stage_coverage_and_repetitions(self):
        pilot = [f"task-{i}" for i in range(10)]
        all_tasks = pilot + ["eleventh"]
        for stage, count in (("oracle", 1), ("trial", 1), ("integration", 3), ("pilot", 10),
                             ("reliability", 30), ("full", 55)):
            self.assertEqual(len(stage_tasks(stage, pilot, all_tasks)), count)
        with self.assertRaises(ValueError):
            stage_tasks("pilot", pilot[:3], all_tasks)
        with self.assertRaises(ValueError):
            stage_tasks("pilot", ["task-0"] * 10, all_tasks)


if __name__ == "__main__":
    unittest.main()
