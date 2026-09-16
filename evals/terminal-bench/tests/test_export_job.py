"""Offline exports exercised with Harbor's real upload loader and archives."""

from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from harbor.models.agent.context import AgentContext
from harbor.models.job.lock import TaskLock, TrialLock, VerifierLock
from harbor.models.trial.result import AgentInfo, ExceptionInfo, ModelInfo, TrialResult
from harbor.models.verifier.result import VerifierResult
# These private APIs define the upload contract of the pinned Harbor release.
from harbor.upload.uploader import _create_job_archive_file, _load_job_from_disk, _read_trial_lock_for_upload

from diffex_terminal_bench.benchmark import PACKAGE, trial_config
from diffex_terminal_bench.dataset import load_config
from diffex_terminal_bench.export_job import export_job
from diffex_terminal_bench.gate import fingerprint, inventory, read_json, sample_tasks, write_json


class ExportJobTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "run/pilot"
        self.output = self.root / "exports/pilot"
        config = load_config(PACKAGE / "benchmark.toml")
        now = datetime.now(timezone.utc)
        self.identity = {"harbor_version": "0.23.0", "concurrency": 3, "harbor_retries": 0,
                         "pilot_tasks": config.pilot_tasks,
                         "task_digests": {task: "sha256:" + "a" * 64 for task in config.pilot_tasks}}
        self.report = {"stage": "pilot", "identity": self.identity, "identity_sha256": fingerprint(self.identity),
                       "started_at": now.isoformat(), "finished_at": now.isoformat(), "passed": True, "trials": []}
        self.directories = []
        for index, task in enumerate(config.pilot_tasks, 1):
            directory = self.source / f"{index:03d}-{task}"
            directory.mkdir(parents=True)
            trial = trial_config(config, Path("/expired/tasks") / task, directory, str(index), oracle=False)
            result = TrialResult(task_name=f"terminal-bench/{task}", trial_name=directory.name, trial_uri=directory.as_uri(),
                task_id=trial.task.get_task_id(), task_checksum="a" * 64, config=trial,
                source="terminal-bench@2.1", started_at=now, finished_at=now,
                agent_info=AgentInfo(name="diffex", version="0.2.4", model_info=ModelInfo(name="gpt-5.5", provider="openai")),
                agent_result=AgentContext(n_input_tokens=20, n_output_tokens=5, cost_usd=0.01),
                verifier_result=VerifierResult(rewards={"reward": int(index != 2)}))
            lock = TrialLock(task=TaskLock(name=task, type="local", digest="sha256:" + "a" * 64),
                             agent=trial.agent, environment=trial.environment, verifier=VerifierLock())
            for name, value in (("config.json", trial), ("result.json", result), ("lock.json", lock)):
                write_json(directory / name, value.model_dump(mode="json"))
            write_json(directory / "sandbox-cleanup.json", {"confirmed": True})
            (directory / "scratch.txt").write_text("excluded by Harbor")
            write_json(directory / "agent/trajectory.json", {"retained": True})
            hidden = directory / "agent/sessions/.subagents/helper"
            hidden.mkdir(parents=True)
            (hidden / "child.jsonl").write_text("child evidence\n")
            self.directories.append(directory)
            self.report["trials"].append({"task": task, "directory": directory.name, "files": inventory(directory)})
        write_json(self.source / "gate.json", self.report)

    def test_cli_exports_job_loadable_by_harbor_and_preserves_archived_traces(self):
        before = inventory(self.source)
        command = subprocess.run([sys.executable, "-m", "diffex_terminal_bench.export_job", str(self.source),
                                  "--output", str(self.output)], capture_output=True, text=True)
        self.assertEqual(command.returncode, 0, command.stderr)
        result, config, trials, directories = _load_job_from_disk(self.output)
        self.assertEqual((result.n_total_trials, result.stats.n_completed_trials, result.stats.n_errored_trials), (10, 10, 0))
        self.assertEqual(result.stats.n_input_tokens, 200)
        self.assertEqual(config.agents[0].model_name, "openai/gpt-5.5")
        self.assertEqual(config.n_concurrent_trials, 3)
        self.assertEqual(config.n_attempts, 1)
        self.assertEqual(len(config.tasks), 10)
        self.assertNotIn("labels", config.environment.kwargs)
        self.assertEqual(trials[1].verifier_result.rewards, {"reward": 0})
        self.assertEqual(inventory(self.source), before)
        for original in self.directories:
            exported = directories[original.name]
            _read_trial_lock_for_upload(exported)
            for relative, digest in inventory(original).items():
                self.assertEqual(inventory(exported)[relative], digest)
        archive = self.root / "job.tar.gz"
        _create_job_archive_file(self.output, archive)
        with tarfile.open(archive) as tar:
            names = tar.getnames()
            self.assertIn(f"pilot/{self.directories[0].name}/agent/sessions/.subagents/helper/child.jsonl", names)
            self.assertIn(f"pilot/{self.directories[0].name}/artifacts/diffex-qualification/gate.json", names)
            self.assertIn(f"pilot/{self.directories[0].name}/artifacts/diffex-qualification/sandbox-cleanup.json", names)
            self.assertFalse(any(name.endswith("/scratch.txt") for name in names))
        repeated = self.root / "another-export"
        export_job(self.source, repeated)
        self.assertEqual(read_json(repeated / "result.json")["id"], str(result.id))

    def test_failed_partial_export_includes_failure_and_unrun_count(self):
        for directory in self.directories[7:]:
            shutil.rmtree(directory)
        path = self.directories[6] / "result.json"
        result = TrialResult.model_validate_json(path.read_text())
        result.exception_info = ExceptionInfo(exception_type="AgentTimeoutError", exception_message="900 seconds",
                                              exception_traceback="retained traceback", occurred_at=result.finished_at)
        result.agent_result = None
        write_json(path, result.model_dump(mode="json"))
        self.report.update(passed=False, trials=self.report["trials"][:6], failure={"error": "ValueError", "trial_index": 7})
        write_json(self.source / "gate.json", self.report)
        with self.assertRaisesRegex(ValueError, "allow-partial"):
            export_job(self.source, self.output)
        export_job(self.source, self.output, allow_partial=True)
        result, _, trials, _ = _load_job_from_disk(self.output)
        self.assertEqual((result.n_total_trials, result.stats.n_completed_trials, result.stats.n_pending_trials), (10, 7, 3))
        self.assertEqual(result.stats.n_errored_trials, 1)
        self.assertEqual(trials[6].exception_info.exception_type, "AgentTimeoutError")
        self.assertIsNone(trials[6].agent_result)
        self.assertEqual(len(read_json(self.output / "export.json")["missing_trials"]), 3)

    def test_sample_exports_only_selected_tasks_with_one_attempt_each(self):
        source = self.root / "sample-run/sample"
        selected = sample_tasks(list(self.identity["task_digests"]), 5, 42)
        identity = {**self.identity, "sample": {"count": 5, "seed": 42, "tasks": selected}}
        report = {**self.report, "stage": "sample", "identity": identity,
                  "identity_sha256": fingerprint(identity), "trials": []}
        originals = {row["task"]: self.source / row["directory"] for row in self.report["trials"]}
        for index, task in enumerate(selected, 1):
            directory = source / f"{index:03d}-{task}"
            shutil.copytree(originals[task], directory)
            result = TrialResult.model_validate_json((directory / "result.json").read_text())
            result.trial_name = directory.name
            result.trial_uri = directory.as_uri()
            result.config.trial_name = directory.name
            result.config.trials_dir = source
            write_json(directory / "result.json", result.model_dump(mode="json"))
            write_json(directory / "config.json", result.config.model_dump(mode="json"))
            report["trials"].append({"task": task, "directory": directory.name, "files": inventory(directory)})
        write_json(source / "gate.json", report)
        export_job(source, self.output)
        result, config, trials, _ = _load_job_from_disk(self.output)
        self.assertEqual(result.n_total_trials, 5)
        self.assertEqual(result.stats.n_completed_trials, 5)
        self.assertEqual(config.n_attempts, 1)
        self.assertEqual([task.path.name for task in config.tasks], selected)
        self.assertEqual(len(trials), 5)
        provenance = self.output / report["trials"][0]["directory"] / "artifacts/diffex-qualification/gate.json"
        self.assertEqual(read_json(provenance)["identity"]["sample"], identity["sample"])

        # A failed sample can still export its terminal results for diagnosis.
        directory = source / report["trials"][-1]["directory"]
        result = TrialResult.model_validate_json((directory / "result.json").read_text())
        result.exception_info = ExceptionInfo(exception_type="AgentTimeoutError", exception_message="900 seconds",
                                              exception_traceback="retained traceback", occurred_at=result.finished_at)
        write_json(directory / "result.json", result.model_dump(mode="json"))
        report.update(passed=False, trials=report["trials"][:-1])
        write_json(source / "gate.json", report)
        partial = self.root / "partial-export"
        with self.assertRaisesRegex(ValueError, "allow-partial"):
            export_job(source, partial)
        export_job(source, partial, allow_partial=True)
        result, _, _, _ = _load_job_from_disk(partial)
        self.assertEqual(result.n_total_trials, 5)
        self.assertEqual(result.stats.n_errored_trials, 1)
        self.assertEqual(read_json(partial / "export.json")["missing_trials"], [])

        identity["sample"]["tasks"].reverse()
        report["identity_sha256"] = fingerprint(identity)
        write_json(source / "gate.json", report)
        with self.assertRaisesRegex(ValueError, "recorded seed"):
            export_job(source, self.root / "tampered-export", allow_partial=True)

    def test_changed_checked_evidence_is_rejected(self):
        (self.directories[0] / "agent/trajectory.json").write_text("changed")
        with self.assertRaisesRegex(ValueError, "checked evidence changed"):
            export_job(self.source, self.output, allow_partial=True)
        self.assertFalse(self.output.exists())

    def test_unfinished_stage_cannot_be_exported(self):
        self.report.pop("finished_at")
        write_json(self.source / "gate.json", self.report)
        with self.assertRaisesRegex(ValueError, "has not stopped"):
            export_job(self.source, self.output, allow_partial=True)

    def test_started_trial_without_result_cannot_be_silently_skipped(self):
        self.report.update(passed=False, trials=[])
        write_json(self.source / "gate.json", self.report)
        (self.directories[-1] / "result.json").unlink()
        with self.assertRaises(FileNotFoundError):
            export_job(self.source, self.output, allow_partial=True)
        self.assertFalse(self.output.exists())

    def test_invalid_lock_and_duplicate_ids_are_rejected(self):
        self.report.update(passed=False, trials=[])
        write_json(self.source / "gate.json", self.report)
        path = self.directories[1] / "result.json"
        value = read_json(path)
        value["id"] = read_json(self.directories[0] / "result.json")["id"]
        write_json(path, value)
        with self.assertRaisesRegex(ValueError, "duplicate trial IDs"):
            export_job(self.source, self.output, allow_partial=True)
        write_json(self.directories[0] / "lock.json", {})
        with self.assertRaises(ValueError):
            export_job(self.source, self.output, allow_partial=True)

    def test_symlinks_and_existing_or_nested_destinations_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "separate"):
            export_job(self.source, self.source / "export")
        self.output.mkdir(parents=True)
        with self.assertRaises(FileExistsError):
            export_job(self.source, self.output)
        target = self.root / "secret"
        target.write_text("never copy")
        (self.directories[0] / "agent/link").symlink_to(target)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            export_job(self.source, self.root / "new-export")

    def test_copy_failure_leaves_no_export_and_preserves_source(self):
        before = inventory(self.source)
        with patch("diffex_terminal_bench.export_job.shutil.copytree", side_effect=OSError("copy failed")):
            with self.assertRaisesRegex(OSError, "copy failed"):
                export_job(self.source, self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(inventory(self.source), before)


if __name__ == "__main__":
    unittest.main()
