"""Credential-free checks for installation safety boundaries."""

from importlib.resources import as_file, files
import json
import os
from pathlib import Path
import subprocess
import sys
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
    def test_release_without_ownership_flags_cannot_complete_installation(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            package = directory / "node_modules/@diffexai/diffex"
            package.mkdir(parents=True)
            tarball = f"{PINS['npm_registry']}@diffexai/diffex/-/diffex-{PINS['diffex_version']}.tgz"
            installed = {"version": PINS["diffex_version"], "integrity": PINS["diffex_integrity"], "resolved": tarball}
            (package / "package.json").write_text(json.dumps({"version": PINS["diffex_version"]}))
            (directory / "package-lock.json").write_text(json.dumps({"packages": {"node_modules/@diffexai/diffex": installed}}))
            (directory / "npm-metadata.json").write_text(json.dumps({"version": PINS["diffex_version"],
                "dist": {"integrity": PINS["diffex_integrity"], "tarball": tarball}}))
            (directory / "version.stdout.txt").write_text(PINS["diffex_version"])
            source = files("diffex_terminal_bench").joinpath("verify-install.cjs").read_text()
            script = directory / "verify-install.cjs"
            script.write_text(source.replace('"/opt/diffex-terminal-bench/cli"', json.dumps(temp)))
            env = {"PATH": os.environ["PATH"], "SETUP_LOGS": temp, "NPM_REGISTRY": PINS["npm_registry"],
                   "DIFFEX_VERSION": PINS["diffex_version"], "DIFFEX_INTEGRITY": PINS["diffex_integrity"],
                   "SETUP_ELAPSED_SEC": "1", "SETUP_TIMEOUT_SEC": "600"}
            for help_text, valid in (("--help", False), ("--background-process-lifetime", False),
                                     ("--background-process-lifetime --background-process-ownership-dir", True)):
                (directory / "help.stdout.txt").write_text(help_text)
                result = subprocess.run(["node", str(script), "complete"], env=env, capture_output=True, text=True, timeout=10)
                with self.subTest(help_text=help_text):
                    self.assertEqual(result.returncode == 0, valid, result.stderr)
                    self.assertEqual((directory / "installation.json").exists(), valid)
                    if not valid:
                        self.assertIn("publish and pin the corrected release", result.stderr)

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


class PackageInstallTests(unittest.TestCase):
    def run_install(self, *, installed=False, update_failures=0, install_failures=0):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            commands = root / "bin"
            commands.mkdir()
            logs = root / "logs"
            logs.mkdir()
            stub = root / "command.py"
            stub.write_text(f"#!{sys.executable}\n" + '''
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["INSTALL_TEST_ROOT"])
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as output:
    output.write(json.dumps([name, *args]) + "\\n")
if name == "uname":
    print("Linux" if args == ["-s"] else "x86_64")
elif name == "dpkg-query":
    if os.environ["INSTALLED"] == "1" or args[-1] != "xz-utils":
        print("install ok installed", end="")
    else:
        sys.exit(1)
elif name == "apt-get":
    operation = "update" if "update" in args else "install"
    counter = root / (operation + ".count")
    count = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(count))
    if count <= int(os.environ[operation.upper() + "_FAILURES"]):
        print("404 Not Found" if operation == "install" else "Failed to fetch index", file=sys.stderr)
        sys.exit(100)
elif name == "wget":
    # Stop after dependency setup; never download or install real packages.
    sys.exit(42)
''')
            stub.chmod(0o755)
            for name in ("uname", "dpkg-query", "apt-get", "wget", "sleep"):
                (commands / name).symlink_to(stub)
            with as_file(files("diffex_terminal_bench").joinpath("install.sh")) as source:
                # Redirect installation paths and capture logs without /dev/fd process substitution.
                script = source.read_text().replace("/opt/diffex-terminal-bench", str(root / "prefix"))
                script = script.replace("/usr/local/bin/diffex", str(root / "diffex"))
                script = script.replace('exec > >(tee "$SETUP_LOGS/install.stdout.log")', "")
                script = script.replace('exec 2> >(tee "$SETUP_LOGS/install.stderr.log" >&2)', "")
            path = root / "install.sh"
            path.write_text(script)
            result = subprocess.run(["bash", str(path)], capture_output=True, text=True, timeout=10, env={
                "PATH": str(commands) + os.pathsep + os.environ["PATH"], "HOME": str(root / "home"),
                "SETUP_LOGS": str(logs), "NODE_VERSION": PINS["node_version"],
                "NODE_SHA256_X64": PINS["node_sha256"]["x64"], "INSTALL_TEST_ROOT": temp,
                "INSTALLED": str(int(installed)), "UPDATE_FAILURES": str(update_failures),
                "INSTALL_FAILURES": str(install_failures),
            })
            self.assertTrue((root / "calls.jsonl").exists(), result.stderr)
            calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
            return result, calls

    def test_installed_dependencies_do_not_need_package_network(self):
        result, calls = self.run_install(installed=True, update_failures=99)
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertFalse(any(call[0] == "apt-get" for call in calls))

    def test_missing_archive_refreshes_indexes_and_retries(self):
        result, calls = self.run_install(install_failures=1)
        self.assertEqual(result.returncode, 42, result.stderr)
        apt = [call for call in calls if call[0] == "apt-get"]
        self.assertEqual(["update" if "update" in call else "install" for call in apt],
                         ["update", "install", "update", "install"])
        for call in apt:
            if "install" in call:
                self.assertIn("xz-utils", call)
                self.assertNotIn("ca-certificates", call)
                self.assertNotIn("wget", call)

    def test_index_failure_does_not_install_from_stale_indexes(self):
        result, calls = self.run_install(update_failures=1)
        self.assertEqual(result.returncode, 42, result.stderr)
        apt = [call for call in calls if call[0] == "apt-get"]
        self.assertEqual(["update" if "update" in call else "install" for call in apt],
                         ["update", "update", "install"])
        self.assertTrue(all("APT::Update::Error-Mode=any" in call for call in apt if "update" in call))

    def test_persistent_failure_is_bounded_and_cannot_report_success(self):
        result, calls = self.run_install(install_failures=99)
        self.assertEqual(result.returncode, 100, result.stderr)
        self.assertEqual(sum(call[0] == "apt-get" and "install" in call for call in calls), 3)
        self.assertFalse(any(call[0] == "wget" for call in calls))


if __name__ == "__main__":
    unittest.main()
