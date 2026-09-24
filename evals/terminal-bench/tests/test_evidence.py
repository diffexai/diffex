"""Exercise the remote evidence collector without a provider or sandbox API."""

from importlib.resources import files
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from diffex_terminal_bench.lifecycle import read_cleanup
from test_outcome import retain_service, write_evidence


class EvidenceTests(unittest.TestCase):
    def test_collector_only_transfers_shutdown_records(self):
        with tempfile.TemporaryDirectory() as temp:
            remote, local = Path(temp) / "remote", Path(temp) / "local"
            write_evidence(remote)
            report = retain_service(remote)
            cache = remote / "state/home/.cache/packages"
            cache.parent.mkdir(parents=True)
            with cache.open("wb") as stream:
                stream.truncate(3 * 1024 ** 3)
            script = files("diffex_terminal_bench").joinpath("evidence.cjs")
            result = subprocess.run(["node", str(script), str(remote)], capture_output=True,
                                    text=True, check=True, timeout=5)
            evidence = json.loads(result.stdout)
            self.assertEqual(set(evidence), {"cleanup.json", "stop-requested", "launcher.json",
                                             "cli.json", "process.json", "ownership/service.json"})
            self.assertLess(len(result.stdout), 4096)
            for name, content in evidence.items():
                target = local / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            self.assertEqual(read_cleanup(local), report)

    def test_missing_required_evidence_is_pending(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run(["node", str(files("diffex_terminal_bench").joinpath("evidence.cjs")), temp],
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0)
            self.assertIsNone(json.loads(result.stdout))


if __name__ == "__main__":
    unittest.main()
