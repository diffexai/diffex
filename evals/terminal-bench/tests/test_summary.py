"""Index generation is local and cannot change qualification evidence."""

import copy
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from diffex_terminal_bench.gate import inventory, write_json
from diffex_terminal_bench.summary import refresh_index, write_index


class SummaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.run = self.root / "run [one]|<test>"
        self.gate = {"identity": {"model": "openai/gpt-5.5", "policy": {"thinking": "xhigh"},
                                  "dataset": {"name": "terminal-bench", "version": "2.1"}},
                     "passed": False, "trials": [], "started_at": "2026-09-15T00:00:00Z"}
        write_json(self.run / "dataset.json", {"dataset": self.gate["identity"]["dataset"], "stages": {"trial": 1}})
        write_json(self.run / "trial/gate.json", self.gate)

    def test_status_rewards_links_and_malformed_runs(self):
        unfinished = write_index(self.root).read_text()
        self.assertIn("unfinished; 0/1 checked; 0 full reward", unfinished)
        gate = copy.deepcopy(self.gate)
        gate.update(passed=True, finished_at="2026-09-15T00:01:00Z",
                    trials=[{"evidence": {"rewards": {"reward": 0}}}])
        write_json(self.run / "trial/gate.json", gate)
        write_json(self.root / "failure/trial/gate.json", {**self.gate, "failure": {"error": "RuntimeError"}})
        broken = self.root / "broken/trial/gate.json"
        broken.parent.mkdir(parents=True)
        broken.write_text("{")
        write_json(self.root / "smoke/smoke.json", {"passed": True})
        (self.root / "broken-link").symlink_to(self.root / "missing")
        (self.root / "duplicate-link").symlink_to(self.run)
        before = inventory(self.run)
        index = write_index(self.root).read_text()
        self.assertEqual(inventory(self.run), before)
        self.assertIn("passed; 1/1 checked; 0 full reward", index)
        self.assertIn("failed; 0 checked; 0 full reward", index)
        self.assertIn("unreadable report", index)
        self.assertIn("run%20%5Bone%5D%7C%3Ctest%3E/trial/gate.json", index)
        self.assertIn("\\[one\\]\\|&lt;test&gt;", index)
        self.assertNotIn("smoke", index)
        self.assertNotIn("duplicate-link", index)
        self.assertIn("not a new verification", index)

    def test_refresh_cli_requires_neither_config_nor_credentials(self):
        env = {key: value for key, value in os.environ.items() if key not in ("OPENAI_API_KEY", "DAYTONA_API_KEY")}
        result = subprocess.run([sys.executable, "-m", "diffex_terminal_bench.benchmark", "--refresh-index",
                                 "--results-dir", str(self.root), "--config", str(self.root / "missing.toml")],
                                capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Updated run index", result.stdout)
        self.assertTrue((self.root / "index.md").is_file())
        self.assertFalse((self.root / "dataset-cache").exists())

    def test_trial_errors_show_progress_until_the_stage_finishes(self):
        gate = {**self.gate, "completed_trials": 2, "expected_trials": 10,
                "failure": {"error": "ValueError"}, "failures": [{"error": "ValueError"}],
                "trials": [{"evidence": {"rewards": {"reward": 0}}}]}
        write_json(self.run / "trial/gate.json", gate)
        self.assertIn("unfinished; 2/10 completed; 1 checked; 1 failed; 0 full reward",
                      write_index(self.root).read_text())
        gate["finished_at"] = "2026-09-15T00:01:00Z"
        write_json(self.run / "trial/gate.json", gate)
        self.assertIn("failed; 2/10 completed; 1 checked; 1 failed; 0 full reward",
                      write_index(self.root).read_text())

    def test_index_failure_is_nonfatal(self):
        with patch("diffex_terminal_bench.summary.write_index", side_effect=OSError("disk full")), \
             patch("sys.stderr") as stderr:
            refresh_index(self.root)
        self.assertTrue(stderr.write.called)


if __name__ == "__main__":
    unittest.main()
