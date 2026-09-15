"""Shared downloads remain verified, atomic, and independent across runs."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch

from diffex_terminal_bench.benchmark import PACKAGE
from diffex_terminal_bench.dataset import load_config, prepare_dataset
from diffex_terminal_bench.gate import sha256


class DatasetCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = load_config(PACKAGE / "benchmark.toml")
        tree = self.root / "tree"
        for name in self.config.pilot_tasks:
            task = tree / "tasks" / name
            (task / "environment").mkdir(parents=True)
            (task / "environment/Dockerfile").write_text("FROM ubuntu:24.04\n")
            (task / "task.toml").write_text('version = "1.0"\n')
            (task / "instruction.md").write_text("fixture")
            (task / "tests").mkdir()
            (task / "tests/test.sh").write_text("exit 0\n")
        self.archive = self.root / "fixture.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            archive.add(tree, arcname="dataset")
        self.config.dataset.archive_sha256 = sha256(self.archive)
        self.config.dataset.task_count = 10
        self.cache = self.root / "cache"

    def test_concurrent_runs_download_once_and_extract_separate_tasks(self):
        barrier = threading.Barrier(4)

        def prepare(_):
            with prepare_dataset(self.config, self.cache) as (tasks, digests):
                barrier.wait(timeout=10)
                path = tasks[self.config.pilot_tasks[0]] / "instruction.md"
                self.assertEqual(path.read_text(), "fixture")
                path.write_text("changed in this run")
                return path, digests

        with patch("diffex_terminal_bench.dataset.urlopen", side_effect=lambda *a, **kw: BytesIO(self.archive.read_bytes())) as download:
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(prepare, range(4)))
            download.assert_called_once_with(self.config.dataset.archive_url, timeout=60)
        self.assertEqual(len({path for path, _ in results}), 4)
        self.assertTrue(all(digests == results[0][1] for _, digests in results))
        self.assertTrue(all(not path.exists() for path, _ in results))
        self.assertEqual(len(list(self.cache.glob("*.tar.gz"))), 1)
        self.assertFalse(list(self.cache.glob(".download-*")))

    def test_invalid_download_is_never_published_and_retry_succeeds(self):
        with patch("diffex_terminal_bench.dataset.urlopen", return_value=BytesIO(b"partial archive")):
            with self.assertRaisesRegex(ValueError, "download SHA-256"), prepare_dataset(self.config, self.cache):
                self.fail("corrupt download accepted")
        self.assertFalse(list(self.cache.glob("*.tar.gz")))
        self.assertFalse(list(self.cache.glob(".download-*")))
        with patch("diffex_terminal_bench.dataset.urlopen", return_value=BytesIO(self.archive.read_bytes())):
            with prepare_dataset(self.config, self.cache) as (tasks, _):
                self.assertEqual(len(tasks), 10)
        saved = self.cache / f"{self.config.dataset.archive_sha256}.tar.gz"
        saved.write_bytes(b"tampered after publication")
        with patch("diffex_terminal_bench.dataset.urlopen") as download:
            with self.assertRaisesRegex(ValueError, "Cached dataset archive SHA-256"), prepare_dataset(self.config, self.cache):
                self.fail("corrupt shared cache accepted")
            download.assert_not_called()

    def test_prepare_cli_reuses_shared_cache_across_output_directories(self):
        self.cache.mkdir()
        (self.cache / f"{self.config.dataset.archive_sha256}.tar.gz").write_bytes(self.archive.read_bytes())
        original = load_config(PACKAGE / "benchmark.toml")
        config = self.root / "benchmark.toml"
        config.write_text((PACKAGE / "benchmark.toml").read_text()
                          .replace(original.dataset.archive_sha256, self.config.dataset.archive_sha256)
                          .replace(f"task_count = {original.dataset.task_count}", "task_count = 10"))
        for name in ("first", "second"):
            output = self.root / "results" / name
            result = subprocess.run([sys.executable, "-m", "diffex_terminal_bench.benchmark", "--prepare",
                                     "--config", str(config), "--dataset-cache", str(self.cache), "--output", str(output)],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Verified 10 pinned tasks", result.stdout)
            self.assertTrue((output / "dataset.json").is_file())
            self.assertFalse((output / "dataset-cache").exists())
        index = (self.root / "results/index.md").read_text()
        self.assertIn("[first](first/)", index)
        self.assertIn("[second](second/)", index)
        self.assertIn("openai/gpt-5.5", index)
        self.assertIn("xhigh", index)


if __name__ == "__main__":
    unittest.main()
