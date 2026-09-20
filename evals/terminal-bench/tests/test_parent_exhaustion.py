"""Source agent -> native JSON -> outcome classification -> next eval trial, offline."""

import asyncio
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from diffex_terminal_bench.benchmark import PACKAGE, REPOSITORY, StageFailedError, run_stage
from diffex_terminal_bench.dataset import load_config
from diffex_terminal_bench.gate import read_json, sample_tasks, write_json
from diffex_terminal_bench.outcome import parse_outcome, require_completed
from test_outcome import write_cleanup


class ParentExhaustionTests(unittest.IsolatedAsyncioTestCase):
    async def test_exhausted_parent_settles_children_and_the_next_trial_completes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = load_config(PACKAGE / "benchmark.toml")
            config.concurrency = 1
            tasks = {name: root / name for name in ("first", "second")}
            selected = sample_tasks(list(tasks), 2, 0)
            identity = {"task_digests": {name: "sha256:fixture" for name in tasks},
                        "sample": {"count": 2, "seed": 0, "tasks": selected}}
            cleaned = []
            outcomes = []

            async def create(trial_config):
                index = int(trial_config.trial_name.split("-", 1)[0])
                if index == 2:
                    self.assertEqual(cleaned, [1])
                directory = trial_config.trials_dir / trial_config.trial_name

                async def run():
                    scenario = "exhausted" if index == 1 else "success"
                    env = {"PATH": os.environ["PATH"], "HOME": str(root), "DIFFEX_OFFLINE": "1",
                           "DIFFEX_CODING_AGENT_DIR": str(root / "state"),
                           "TSX_TSCONFIG_PATH": str(REPOSITORY / "tsconfig.json")}
                    process = await asyncio.create_subprocess_exec(
                        "node", "--import", str(REPOSITORY / "node_modules/tsx/dist/loader.mjs"),
                        str(REPOSITORY / "packages/coding-agent/test/suite/fixtures/eval-parent.ts"), scenario, str(directory),
                        cwd=REPOSITORY, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    try:
                        stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
                    finally:
                        if process.returncode is None:
                            process.kill()
                            await process.wait()
                    self.assertEqual(process.returncode, 1 if index == 1 else 0, stderr.decode())
                    (directory / "stdout.jsonl").write_bytes(stdout)
                    (directory / "stderr.log").write_bytes(stderr)
                    write_json(directory / "process.json", {"exit_code": process.returncode})
                    write_cleanup(directory)
                    requested = {"provider": "faux", "model": "fixture", "thinking": "off",
                                 "instruction_sha256": "fixture", "tools": [], "background_process_lifetime": "environment"}
                    write_json(directory / "requested.json", requested)
                    write_json(directory / "effective.json", {**requested, "release_agents_loaded": True,
                                                               "instruction_delivered": True})
                    outcome = parse_outcome(directory, launcher_exit_code=process.returncode)
                    outcomes.append(outcome)
                    require_completed(outcome)

                return Mock(run=run)

            async def cleanup(client, directory, label):
                cleaned.append(int(directory.name.split("-", 1)[0]))
                return {"confirmed": True}

            manager = Mock(_cleanup=AsyncMock())
            with patch("diffex_terminal_bench.benchmark.AsyncDaytona"), \
                 patch("diffex_terminal_bench.benchmark.Trial.create", side_effect=create), \
                 patch("diffex_terminal_bench.benchmark.Packager.compute_content_hash", return_value=("fixture", [])), \
                 patch("diffex_terminal_bench.benchmark.confirm_cleanup", side_effect=cleanup), \
                 patch("diffex_terminal_bench.benchmark.validate_trial", return_value={"rewards": {"reward": 1}}), \
                 patch("diffex_terminal_bench.benchmark.refresh_index"), \
                 patch("diffex_terminal_bench.benchmark.DaytonaClientManager.get_instance", return_value=manager):
                with self.assertRaisesRegex(StageFailedError, "completed 2 trials with 1 failed"):
                    await run_stage(config, tasks, identity, root, "sample")

            self.assertEqual([outcome["status"] for outcome in outcomes], ["provider_failure", "completed"])
            self.assertTrue(all(outcome["stream_complete"] for outcome in outcomes))
            self.assertEqual(outcomes[0]["retry_attempts"], 3)
            self.assertEqual(cleaned, [1, 2])
            report = read_json(root / "sample/gate.json")
            self.assertEqual(report["completed_trials"], 2)
            self.assertEqual(report["failure"]["error"], "DiffexExecutionError")
            self.assertEqual(report["trials"][0]["task"], selected[1])
            failed = read_json(root / "sample" / f"001-{selected[0]}" / "parent.json")
            self.assertEqual(failed["parentCalls"], 5)
            self.assertEqual(failed["childCalls"], 1)
            self.assertTrue(failed["childSettled"])
            self.assertEqual([child["status"] for child in failed["children"]], ["interrupted", "interrupted"])
            self.assertEqual(failed["lastMessage"]["stopReason"], "error")
            self.assertEqual(failed["error"], "429 rate limit exhausted")
            successful = read_json(root / "sample" / f"002-{selected[1]}" / "parent.json")
            self.assertEqual(successful["parentCalls"], 4)
            self.assertTrue(successful["childSettled"])
            self.assertEqual(successful["children"][0]["status"], "idle")
            self.assertEqual(successful["lastMessage"]["stopReason"], "stop")
            manager._cleanup.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
