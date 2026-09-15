"""Credential-free checks for installation safety boundaries."""

from importlib.resources import as_file, files
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import create_autospec, patch

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

from diffex_terminal_bench.adapter import DiffexAgent
from diffex_terminal_bench.config import PINS


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_unpinned_version_fails_before_install(self):
        environment = create_autospec(BaseEnvironment, instance=True)
        agent = DiffexAgent(logs_dir=Path("unused"), version="999.0.0")
        with self.assertRaisesRegex(ValueError, "pins.toml"):
            await agent.install(environment)
        environment.exec.assert_not_called()
        environment.upload_file.assert_not_called()

    async def test_unpinned_harbor_fails_before_install(self):
        environment = create_autospec(BaseEnvironment, instance=True)
        agent = DiffexAgent(logs_dir=Path("unused"))
        with patch("diffex_terminal_bench.adapter.version", return_value="0.0.0"):
            with self.assertRaisesRegex(RuntimeError, "uv sync --locked"):
                await agent.install(environment)
        environment.exec.assert_not_called()

    async def test_failed_install_cannot_report_success(self):
        environment = create_autospec(BaseEnvironment, instance=True)
        environment.exec.side_effect = [
            ExecResult(return_code=0, stdout="", stderr=""),
            ExecResult(return_code=1, stdout="", stderr="Integrity mismatch"),
        ]
        agent = DiffexAgent(logs_dir=Path("unused"))
        with self.assertRaisesRegex(RuntimeError, "Integrity mismatch"):
            await agent.install(environment)

    async def test_execution_requires_explicit_model(self):
        environment = create_autospec(BaseEnvironment, instance=True)
        agent = DiffexAgent(logs_dir=Path("unused"))
        with self.assertRaisesRegex(ValueError, "provider/model"):
            await agent.run("Do a task", environment, AgentContext())
        environment.exec.assert_not_called()


class RegistryIntegrityTests(unittest.TestCase):
    def test_registry_metadata_must_match_all_pins(self):
        tarball = f"{PINS['npm_registry']}@diffexai/diffex/-/diffex-{PINS['diffex_version']}.tgz"
        cases = (
            (PINS["diffex_version"], PINS["diffex_integrity"], tarball, True),
            ("999.0.0", PINS["diffex_integrity"], tarball, False),
            (PINS["diffex_version"], "sha512-wrong", tarball, False),
            (PINS["diffex_version"], PINS["diffex_integrity"], "https://example.com/diffex.tgz", False),
        )
        for version, integrity, url, valid in cases:
            with self.subTest(version=version, integrity=integrity, url=url):
                with tempfile.TemporaryDirectory() as temp:
                    metadata = {"version": version, "dist": {"integrity": integrity, "tarball": url}}
                    Path(temp, "npm-metadata.json").write_text(json.dumps(metadata))
                    env = {
                        "PATH": os.environ["PATH"],
                        "SETUP_LOGS": temp,
                        "NPM_REGISTRY": PINS["npm_registry"],
                        "DIFFEX_VERSION": PINS["diffex_version"],
                        "DIFFEX_INTEGRITY": PINS["diffex_integrity"],
                    }
                    with as_file(files("diffex_terminal_bench").joinpath("verify-install.cjs")) as script:
                        result = subprocess.run(
                            ["node", str(script), "metadata"], env=env,
                            capture_output=True, text=True, check=False,
                        )
                    self.assertEqual(result.returncode == 0, valid, result.stderr)
                    self.assertFalse(Path(temp, "installation.json").exists())


if __name__ == "__main__":
    unittest.main()
