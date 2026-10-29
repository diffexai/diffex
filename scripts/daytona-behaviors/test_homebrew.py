"""Credential-free Homebrew fixture/report contracts, not real brew qualification."""
import argparse
import hashlib
import json
import os
import stat
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from homebrew import HomebrewRunner, MARKER, candidate_formula, choose_record, fingerprint, link_fixture_modules, verify_payload_inventory
from daytona_runner import REMOTE_BUNDLE, Runner as DaytonaRunner, State
from test_daytona_runner import FakeClient
import time


def seal_payload_fixture(payload, record):
    files = []
    for directory, dirs, names in os.walk(payload, followlinks=False):
        for name in dirs + names:
            path = Path(directory, name)
            local = path.relative_to(payload).as_posix()
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode) or local == "distribution-files.json":
                continue
            item = {"path": local, "mode": stat.S_IMODE(info.st_mode)}
            if path.is_symlink():
                item.update(type="link", target=os.readlink(path))
            else:
                item.update(type="file", size=info.st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            files.append(item)
    content = (json.dumps({"schemaVersion": 1, "algorithm": "sha256", "files": sorted(files, key=lambda item: item["path"])}, sort_keys=True) + "\n").encode()
    inventory = payload / "distribution-files.json"
    inventory.write_bytes(content)
    inventory.chmod(0o644)
    record["inventorySha256"] = hashlib.sha256(content).hexdigest()


def make_payload_fixture(payload):
    record = {"version": "1.2.3", "sourceCommit": "a" * 40, "platform": "linux-x64",
              "nodeVersion": "22.23.2", "npmVersion": "11.16.0"}
    cli = payload / "app/node_modules/@diffexai/diffex"
    cli.mkdir(parents=True, exist_ok=True)
    (payload / "bin").mkdir(exist_ok=True)
    for path, value in ((payload / "distribution.json", {"schemaVersion": 1, "product": "@diffexai/diffex",
                        "version": record["version"], "sourceCommit": record["sourceCommit"], "platform": record["platform"],
                        "runtime": {key: record[key] for key in ("nodeVersion", "npmVersion")}}),
                        (cli / "package.json", {"name": "@diffexai/diffex", "version": record["version"]}),
                        (cli / "distribution-files.json", {"sourceCommit": record["sourceCommit"]})):
        path.write_text(json.dumps(value))
        path.chmod(0o644)
    (payload / "data.txt").write_text("preserved bytes")
    (payload / "data.txt").chmod(0o644)
    (payload / "bin/diffex").write_text("#!/bin/sh\nexit 0\n")
    (payload / "bin/diffex").chmod(0o755)
    link = payload / "bin/alias"
    link.symlink_to("diffex")
    if stat.S_IMODE(link.lstat().st_mode) != 0o777:
        os.chmod(link, 0o777, follow_symlinks=False)
    seal_payload_fixture(payload, record)
    return record


class HomebrewTests(unittest.TestCase):
    def test_formula_uses_explicit_local_archive_and_canonical_marker_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "candidate.tar.gz"
            record = {"version": "1.2.3", "sha256": "a" * 64}
            formula = candidate_formula(archive, record, 1)
            self.assertIn(archive.resolve().as_uri(), formula)
            self.assertIn('libexec.install buildpath => "diffex"', formula)
            self.assertIn('bin.install_symlink libexec/"diffex/bin/diffex"', formula)
            self.assertIn("revision 1", formula)
            self.assertIn("diffexai/tap/diffex", formula)
            self.assertEqual(MARKER["schemaVersion"], 1)
            self.assertNotIn("https://github.com/diffexai/diffex/releases/download", formula)

    def test_record_selection_verifies_source_hash_size_and_unique_native_record(self):
        with tempfile.TemporaryDirectory() as temporary, patch("homebrew.platform.machine", return_value="x86_64"), patch("homebrew.sys.platform", "linux"):
            root = Path(temporary)
            archive = root / "candidate.tar.gz"
            archive.write_bytes(b"retained")
            record = {"version": "1.2.3", "sourceCommit": "a" * 40, "platform": "linux-x64",
                      "filename": archive.name, "size": 8, "sha256": hashlib.sha256(b"retained").hexdigest()}
            path = root / "candidate.json"
            path.write_text(json.dumps(record))
            self.assertEqual(choose_record(root, "a" * 40), (archive, path, record))
            with self.assertRaises(AssertionError):
                choose_record(root, "b" * 40)
            archive.write_bytes(b"tampered")
            with self.assertRaises(AssertionError):
                choose_record(root, "a" * 40)

    def test_record_selection_supports_all_four_native_targets(self):
        for os_name, machine, target in (("darwin", "arm64", "darwin-arm64"), ("darwin", "x86_64", "darwin-x64"),
                                         ("linux", "aarch64", "linux-arm64"), ("linux", "x86_64", "linux-x64")):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / "candidate.tar.gz"
                archive.write_bytes(b"fixture")
                record = {"version": "1.2.3", "sourceCommit": "a" * 40, "platform": target,
                          "filename": archive.name, "size": 7, "sha256": hashlib.sha256(b"fixture").hexdigest()}
                (root / "candidate.json").write_text(json.dumps(record))
                with patch("homebrew.platform.machine", return_value=machine), patch("homebrew.sys.platform", os_name):
                    self.assertEqual(choose_record(root, "a" * 40)[2]["platform"], target)

    def test_native_lifecycle_only_orchestration_contract_uses_no_daytona_or_tui(self):
        # This mock checks control flow only. It does not qualify real brew behavior.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runner = HomebrewRunner(argparse.Namespace(output=root / "evidence", commit="a" * 40,
                                                       artifacts=root, lifecycle_only=True))
            record = {"version": "1.2.3", "sha256": "b" * 64, "filename": "candidate.tar.gz"}
            calls = []
            revision = 0
            present = False
            tap = root / "tap"
            (tap / "Formula").mkdir(parents=True)
            prefixes = []
            for index in (0, 1):
                prefix = root / f"keg-{index}"
                (prefix / "libexec/diffex/app/node_modules").mkdir(parents=True)
                (prefix / "libexec/.diffex-homebrew.json").write_text(json.dumps(MARKER))
                record.update(make_payload_fixture(prefix / "libexec/diffex"))
                prefixes.append(prefix)
            def brew(command):
                nonlocal revision, present
                calls.append(command)
                if command[0] == "install":
                    present = True
                elif command[0] == "upgrade":
                    revision = 1
                elif command[0] == "uninstall":
                    present = False
                elif command[0] == "--prefix":
                    return str(prefixes[revision])
                elif command[0] == "--repository":
                    return str(tap)
                elif command[0] == "list":
                    return "diffex 1.2.3" if present else ""
                return ""
            def product(executable, args, env, project, evidence):
                self.assertNotIn("node", [path.name for path in Path(env["PATH"]).iterdir()])
                self.assertEqual(env["DIFFEX_OFFLINE"], "1")
                output = "brew upgrade diffexai/tap/diffex" if args[0] == "update" else "Usage 1.2.3 models"
                (evidence / "stdout.txt").write_text(output)
                return output
            runner.brew_command = brew
            runner.process = product
            with patch("homebrew.choose_record", return_value=(root / "candidate.tar.gz", root / "candidate.json", record)), \
                 patch("homebrew.shutil.which", side_effect=lambda name: "/fixture/brew" if name == "brew" else None), \
                 patch("homebrew.os.getuid", return_value=1000), patch("homebrew.subprocess.run"), \
                 patch.object(runner, "deterministic") as tui:
                self.assertTrue(runner.run())
                tui.assert_not_called()
            self.assertEqual([item["id"] for item in runner.results], ["homebrew-formula-install", "homebrew-formula-upgrade-retention", "homebrew-formula-uninstall-retention"])
            self.assertIn(["upgrade", "--formula", "diffexai/tap/diffex"], calls)
            self.assertEqual(calls[-1], ["untap", "diffexai/tap"])
            for scenario in ("homebrew-formula-install", "homebrew-formula-upgrade-retention"):
                evidence = json.loads((root / "evidence" / scenario / "lifecycle.json").read_text())
                self.assertEqual(evidence["payloadInventory"]["inventorySha256"], record["inventorySha256"])
                self.assertGreater(evidence["payloadInventory"]["filesVerified"], 0)
            for path in (root / "evidence").rglob("*"):
                self.assertNotEqual(path.name, "auth.json")
                self.assertNotEqual(path.name, ".npmrc")

    def test_installed_inventory_is_read_only_and_rejects_byte_mode_type_path_link_and_identity_mutations(self):
        for mutation in (None, "inventory", "bytes", "size", "mode", "missing", "extra", "type", "link", "source", "version", "platform", "runtime", "unsafe-path", "special"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                payload = Path(temporary) / "payload"
                record = make_payload_fixture(payload)
                data = payload / "data.txt"
                if mutation == "inventory":
                    with (payload / "distribution-files.json").open("a") as stream:
                        stream.write(" ")
                elif mutation == "bytes":
                    data.write_bytes(b"x" + data.read_bytes()[1:])
                elif mutation == "size":
                    data.write_text("truncated")
                elif mutation == "mode":
                    data.chmod(0o600)
                elif mutation == "missing":
                    data.unlink()
                elif mutation == "extra":
                    (payload / "extra").write_text("unretained")
                elif mutation == "type":
                    data.unlink()
                    data.symlink_to("bin/diffex")
                elif mutation == "link":
                    (payload / "bin/alias").unlink()
                    (payload / "bin/alias").symlink_to("../data.txt")
                    if stat.S_IMODE((payload / "bin/alias").lstat().st_mode) != 0o777:
                        os.chmod(payload / "bin/alias", 0o777, follow_symlinks=False)
                elif mutation in {"source", "version", "platform", "runtime"}:
                    metadata = json.loads((payload / "distribution.json").read_text())
                    if mutation == "runtime":
                        metadata["runtime"]["nodeVersion"] = "99.0.0"
                    else:
                        metadata[{"source": "sourceCommit", "version": "version", "platform": "platform"}[mutation]] = "different"
                    (payload / "distribution.json").write_text(json.dumps(metadata))
                    seal_payload_fixture(payload, record)
                elif mutation == "unsafe-path":
                    inventory_path = payload / "distribution-files.json"
                    inventory = json.loads(inventory_path.read_text())
                    inventory["files"][0]["path"] = "../escape"
                    inventory_path.write_text(json.dumps(inventory))
                    record["inventorySha256"] = hashlib.sha256(inventory_path.read_bytes()).hexdigest()
                elif mutation == "special":
                    os.mkfifo(payload / "fifo")
                before = fingerprint(payload) if mutation != "special" else None
                if mutation is None:
                    result = verify_payload_inventory(payload, record)
                    self.assertEqual(result["inventorySha256"], record["inventorySha256"])
                else:
                    with self.assertRaises(AssertionError):
                        verify_payload_inventory(payload, record)
                if before is not None:
                    self.assertEqual(fingerprint(payload), before, "Inventory verification mutated the candidate")

    def test_external_provider_modules_link_to_cli_bundled_layout_without_top_level_ai_or_tui(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / "payload"
            cli = payload / "app/node_modules/@diffexai/diffex"
            bundled = cli / "dist/node_modules/@diffexai"
            for name, path in (("diffex", cli), ("diffex-ai", bundled / "diffex-ai"), ("diffex-tui", bundled / "diffex-tui")):
                path.mkdir(parents=True, exist_ok=True)
                (path / "package.json").write_text(json.dumps({"name": f"@diffexai/{name}"}))
            self.assertEqual([path.name for path in (payload / "app/node_modules/@diffexai").iterdir()], ["diffex"])
            before = fingerprint(payload)
            external = root / "external"
            link_fixture_modules(payload, external)
            scope = external / "node_modules/@diffexai"
            self.assertEqual((scope / "diffex").resolve(), cli.resolve())
            self.assertEqual((scope / "diffex-ai").resolve(), (bundled / "diffex-ai").resolve())
            self.assertEqual((scope / "diffex-tui").resolve(), (bundled / "diffex-tui").resolve())
            self.assertEqual(fingerprint(payload), before)

    def test_shared_behavior_harness_resolves_installed_sdk_and_restricts_product_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runner = HomebrewRunner(argparse.Namespace(output=root / "evidence", commit="a" * 40))
            runner.payload = root / "cellar/libexec/diffex"
            runner.tools = root / "tools"
            runner.fixture_root = root / "external-fixtures"
            env = runner.environment(root / "work")
            self.assertEqual(env["PATH"], str(runner.tools))
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("DAYTONA_API_KEY", env)
            self.assertEqual(runner.fixture_directory("/brew/bin/diffex"), runner.fixture_root)
            self.assertEqual(env["DIFFEX_OFFLINE"], "1")
            self.assertEqual(env["DIFFEX_SKIP_VERSION_CHECK"], "1")
            runner.scenario("fixture", lambda evidence: (evidence / "safe.json").write_text("{}"))
            self.assertEqual(json.loads((root / "evidence/results.json").read_text())["mode"], "homebrew")
            self.assertEqual(runner.args.mode, "deterministic")

    def test_daytona_homebrew_launch_never_forwards_provider_keys_and_recovers_without_relaunch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "output"
            output.mkdir()
            state = State("workflow-homebrew", "unique-homebrew", {"diffex-run": "fixture"},
                          "a" * 40, "homebrew", "brew-toolchain", time.time(), time.time() + 60)
            state.save(output)
            client = FakeClient(output)
            runner = DaytonaRunner(client, output, state, poll_seconds=0)
            sandbox = runner.create()
            with patch.dict(os.environ, {"OPENAI_API_KEY": "canary-no-forward"}):
                runner.launch(sandbox, "canary-no-forward")
            launch = client.fs.files["/tmp/diffex-launch.py"].decode()
            self.assertIn(f"{REMOTE_BUNDLE}/scripts/daytona-behaviors/homebrew.py", launch)
            self.assertNotIn("canary-no-forward", launch)
            self.assertTrue(all(not env for _, env in client.process.calls))
            self.assertEqual(runner.recover(0), 0)
            self.assertEqual(client.creates, 1)
            self.assertEqual(sum(command.startswith("nohup ") for command, _ in client.process.calls), 1)
            self.assertEqual(state.cleanup, "confirmed")


if __name__ == "__main__":
    unittest.main()
