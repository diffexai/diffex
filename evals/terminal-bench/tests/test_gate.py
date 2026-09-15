"""Gate regressions exercise real native parsing and ATIF conversion."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

from harbor.models.agent.context import AgentContext
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig

from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.gate import inventory, require_previous, sha256, stage_tasks, validate_trial, write_json
from diffex_terminal_bench.outcome import parse_outcome
from diffex_terminal_bench.trajectory import export_trajectory
from test_trajectory import assistant, entry


class GateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.directory = self.root / "oracle" / "task-1"
        self.run = self.directory / "agent/run-fixture"
        self.run.mkdir(parents=True)
        self.identity = {"model": "openai/gpt-5", "policy": {"thinking": "high", "tools": "bash",
                         "subagents": "disabled", "project_resources": "context-only"},
                         "release_agents_sha256": "release-hash", "task_digests": {"task": "sha256:task"}}
        requested = {"provider": "openai", "model": "gpt-5", "thinking": "high", "tools": ["bash"],
                     "subagents": "disabled", "project_resources": "context-only", "pins": PINS,
                     "evolution": {"enabled": False}, "state_policy": "fresh-per-run"}
        (self.run / "instruction.txt").write_text("task")
        (self.run / "system-prompt.txt").write_text("system")
        requested["instruction_sha256"] = sha256(self.run / "instruction.txt")
        write_json(self.run / "requested.json", requested)
        write_json(self.run / "effective.json", {**requested, "release_agents_loaded": True, "instruction_delivered": True,
                   "release_agents_sha256": "release-hash", "system_prompt_sha256": sha256(self.run / "system-prompt.txt")})
        write_json(self.run / "process.json", {"exit_code": 0})
        write_json(self.run / "cleanup.json", {"confirmed": True})
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

    def test_zero_reward_is_valid_benchmark_result(self):
        report = validate_trial(self.directory, "task", self.identity)
        self.assertEqual(report["rewards"], {"reward": 0})
        self.assertEqual(report["usage"]["prompt_tokens"], 19)

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
        for key, value in (("model", "openai/gpt-4"), ("release_agents_sha256", "changed")):
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
