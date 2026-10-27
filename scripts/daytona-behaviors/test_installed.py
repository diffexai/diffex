"""Fast report/normalization/budget regression tests; installed integration is a separate command."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("installed", Path(__file__).with_name("installed.py"))
installed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installed)


class InstalledTests(unittest.TestCase):
    def runner(self, output, artifacts=None):
        return installed.Runner(argparse.Namespace(output=Path(output), commit="a" * 40,
            mode="deterministic", executable=None, artifacts=artifacts, model="openai/gpt-4.1-mini", update_baselines=False))

    def test_failed_assertion_is_recorded_once_and_not_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.runner(temporary)
            calls = []
            def fail(evidence):
                calls.append(evidence)
                raise AssertionError("intentional assertion failure")
            self.assertFalse(runner.scenario("fixture-failure", fail))
            self.assertEqual(len(calls), 1)
            report = json.loads((Path(temporary) / "results.json").read_text())
            self.assertEqual(report["outcome"], "failed")
            self.assertEqual(report["scenarios"][0]["category"], "product")
            self.assertEqual(ET.parse(Path(temporary) / "results.xml").getroot().attrib["failures"], "1")

    def test_corrupt_artifact_fails_before_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "cli.tgz"
            archive.write_bytes(b"tampered")
            installed.write_json(root / "manifest.json", {"source": {"commit": "a" * 40}, "packages": [
                {"filename": "cli.tgz", "sha256": "0" * 64}]})
            runner = self.runner(root / "output", root)
            self.assertFalse(runner.run())
            self.assertEqual([s["id"] for s in runner.results], ["artifact-integrity"])
            self.assertIn("checksum", runner.results[0]["error"])

    def test_provider_and_configuration_failures_are_distinct(self):
        for status, category in ((401, "configuration"), (429, "provider"), (503, "provider")):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                runner = self.runner(temporary)
                def fail(evidence):
                    (evidence / "events.jsonl").write_text(json.dumps({"type": "response", "status": status}) + "\n")
                    raise AssertionError("No response")
                self.assertFalse(runner.scenario("live", fail))
                self.assertEqual(runner.results[0]["category"], category)

    def test_normalization_preserves_layout_and_behavior_text(self):
        env = {"HOME": "/tmp/home", "DIFFEX_PROJECT": "/tmp/project"}
        actual = installed.normalize_screen("Diffex v0.4.0\n  /tmp/project\nbehavior-tools-ok\n", env)
        self.assertEqual(actual, "Diffex v<VERSION>\n  <PROJECT>\nbehavior-tools-ok\n")

    def test_empty_results_cannot_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.runner(temporary)
            runner.save()
            self.assertEqual(json.loads((Path(temporary) / "results.json").read_text())["outcome"], "failed")


if __name__ == "__main__":
    unittest.main()
