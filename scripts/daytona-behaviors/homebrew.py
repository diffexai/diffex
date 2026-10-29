#!/usr/bin/env python3
"""Real brew lifecycle of retained candidate bytes, not published tap qualification.

Requires preprovisioned non-root Homebrew. Never installs Homebrew, uses provider
credentials, or substitutes a fake brew executable. For native matrix runners:

python3 scripts/daytona-behaviors/homebrew.py --artifacts ARCHIVE_DIRECTORY \\
    --output EVIDENCE_DIRECTORY --commit SOURCE_SHA --lifecycle-only

The lifecycle-only mode is portable to macOS/Linux x64/arm64 and imports only
stdlib plus the sibling installed.py harness (no Daytona SDK).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile

from installed import Runner

HERE = Path(__file__).resolve().parent
MARKER = {"schemaVersion": 1, "package": "@diffexai/diffex", "formula": "diffexai/tap/diffex"}
TOOLS = ("sh", "bash", "dirname", "readlink", "uname", "cat", "env", "tmux", "python3", "rg", "fd",
         "git", "mkdir", "sed", "tr", "head", "tail", "stty", "sleep", "kill", "which", "tput", "clear",
         "date", "realpath", "cut", "sort", "wc", "find", "xargs", "ls", "cp", "rm")


def safe_directory(value):
    """Restrict CLI inputs to the workspace or native temporary directories."""
    directory = Path(value).resolve()
    roots = (Path.cwd().resolve(), Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve())
    if not any(root != Path(root.anchor) and
               (directory == root or str(directory).startswith(str(root) + os.sep)) for root in roots):
        raise ValueError("Directory must be inside the workspace or a temporary directory")
    return directory


def retained_file(directory, name, suffix):
    """Validate a retained basename and reject symlinks before accessing its bytes."""
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*" + re.escape(suffix), name):
        raise ValueError("Invalid retained filename")
    path = (directory / name).resolve(strict=True)
    if not str(path).startswith(str(directory) + os.sep) or path != directory / name:
        raise ValueError("Retained file must be directly inside the artifact directory")
    if not path.is_file():
        raise ValueError("Retained artifact must be a regular file")
    return path


def candidate_formula(archive, record, revision=0):
    # Explicit trusted prepublication file fixture. No production URL override API.
    # Brew strips the sole diffex/ archive root before the canonical install stanza.
    archive = retained_file(safe_directory(archive.parent), archive.name, ".tar.gz")
    return f'''class Diffex < Formula
  desc "Diffex retained candidate lifecycle fixture (not the published tap)"
  homepage "https://github.com/diffexai/diffex"
  url {json.dumps(archive.as_uri())}
  version {json.dumps(record["version"])}
  sha256 {json.dumps(record["sha256"])}
  revision {revision}
  def install
    libexec.install buildpath => "diffex"
    (libexec/".diffex-homebrew.json").write {json.dumps(json.dumps(MARKER))}
    bin.install_symlink libexec/"diffex/bin/diffex"
  end
  test do
    assert_match version.to_s, shell_output("#{{bin}}/diffex --version")
  end
end
'''


def verify_payload_inventory(payload, record):
    """Read-only comparison with the retained archive's exact nondirectory inventory."""
    payload = Path(payload).resolve(strict=True)
    inventory_path = payload / "distribution-files.json"
    inventory_info = inventory_path.lstat()
    assert stat.S_ISREG(inventory_info.st_mode) and inventory_info.st_size <= 32 * 1024 * 1024, "Invalid payload inventory file"
    assert stat.S_IMODE(inventory_info.st_mode) == 0o644, "Payload inventory mode changed"
    inventory_bytes = inventory_path.read_bytes()
    inventory_hash = hashlib.sha256(inventory_bytes).hexdigest()
    assert inventory_hash == record["inventorySha256"], "Retained payload inventory SHA256 mismatch"
    inventory = json.loads(inventory_bytes)
    assert inventory["schemaVersion"] == 1 and inventory["algorithm"] == "sha256", "Invalid payload inventory schema"
    assert isinstance(inventory["files"], list) and 0 < len(inventory["files"]) <= 100000, "Invalid payload inventory entries"
    expected = {}
    folded = set()
    for item in inventory["files"]:
        name = item["path"]
        path = PurePosixPath(name)
        assert (name and not path.is_absolute() and str(path) == name and ".." not in path.parts
                and "\\" not in name and ":" not in name and not any(ord(char) < 32 or ord(char) == 127 for char in name)), "Unsafe payload inventory path"
        assert name != "distribution-files.json" and name.casefold() not in folded, "Duplicate or self-referencing payload inventory path"
        folded.add(name.casefold())
        assert item["type"] in {"file", "link"}, "Invalid payload inventory type"
        expected[name] = item
    actual = {}
    for directory, dirs, files in os.walk(payload, followlinks=False):
        for name in dirs + files:
            path = Path(directory, name)
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            local = path.relative_to(payload).as_posix()
            assert stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode), "Special file in installed payload"
            if local != "distribution-files.json":
                actual[local] = (path, info)
        dirs[:] = [name for name in dirs if not Path(directory, name).is_symlink()]
    assert actual.keys() == expected.keys(), "Installed payload path set differs from retained inventory"
    for name, item in expected.items():
        path, info = actual[name]
        assert type(item["mode"]) is int and stat.S_IMODE(info.st_mode) == item["mode"], "Installed payload mode differs from retained inventory"
        if item["type"] == "link":
            assert stat.S_ISLNK(info.st_mode) and item["mode"] in {0o755, 0o777}, "Installed payload link type changed"
            assert os.readlink(path) == item["target"], "Installed payload link target changed"
            assert not Path(item["target"]).is_absolute() and path.resolve(strict=True).is_relative_to(payload), "Installed payload link escapes or is dangling"
        else:
            assert stat.S_ISREG(info.st_mode) and item["mode"] in {0o644, 0o755}, "Installed payload file type changed"
            assert type(item["size"]) is int and info.st_size == item["size"], "Installed payload size changed"
            with path.open("rb") as stream:
                assert hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"], "Installed payload file SHA256 changed"
    metadata = json.loads((payload / "distribution.json").read_text())
    assert metadata["schemaVersion"] == 1 and metadata["product"] == "@diffexai/diffex", "Installed payload product identity changed"
    for field in ("version", "sourceCommit", "platform"):
        assert metadata[field] == record[field], "Installed payload source/version/platform identity changed"
    for field in ("nodeVersion", "npmVersion"):
        assert metadata["runtime"][field] == record[field], "Installed payload runtime identity changed"
    cli = payload / "app/node_modules/@diffexai/diffex"
    package = json.loads((cli / "package.json").read_text())
    assert package["name"] == "@diffexai/diffex" and package["version"] == record["version"], "Installed CLI package identity changed"
    assert json.loads((cli / "distribution-files.json").read_text())["sourceCommit"] == record["sourceCommit"], "Installed CLI source identity changed"
    return {"inventorySha256": inventory_hash, "filesVerified": len(expected)}


def link_fixture_modules(payload, fixture_root):
    payload = payload.resolve()
    cli = payload / "app/node_modules/@diffexai/diffex"
    bundled = cli / "dist/node_modules/@diffexai"
    scope = fixture_root / "node_modules/@diffexai"
    scope.mkdir(parents=True)
    for name, target in [("diffex", cli), *((path.name, path) for path in sorted(bundled.iterdir()))]:
        assert re.fullmatch(r"[a-z0-9][a-z0-9._-]*", name)
        target = target.resolve()
        assert target.is_relative_to(payload), "Fixture module escapes retained payload"
        assert json.loads((target / "package.json").read_text())["name"] == f"@diffexai/{name}"
        (scope / name).symlink_to(target, target_is_directory=True)
    assert (scope / "diffex-ai/package.json").is_file(), "Missing bundled AI fixture SDK"
    assert (scope / "diffex-tui/package.json").is_file(), "Missing bundled TUI fixture SDK"


def fingerprint(directory):
    entries = []
    for path in sorted(directory.rglob("*")):
        name = path.relative_to(directory).as_posix()
        if path.is_symlink():
            entries.append((name, "link", os.readlink(path)))
        elif path.is_dir():
            entries.append((name, "directory", path.stat().st_mode))
        else:
            entries.append((name, "file", path.stat().st_mode, hashlib.sha256(path.read_bytes()).hexdigest()))
    return entries


def choose_record(artifacts, commit):
    artifacts = safe_directory(artifacts)
    if not artifacts.is_dir():
        raise ValueError("Artifact directory does not exist")
    native = sys.platform + "-" + {"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}[platform.machine()]
    candidates = []
    for entry in artifacts.glob("*.json"):
        path = retained_file(artifacts, entry.name, ".json")
        value = json.loads(path.read_text())
        if value.get("platform") == native and value.get("filename", "").endswith(".tar.gz"):
            candidates.append((path, value))
    if len(candidates) != 1:
        raise AssertionError("Expected one retained native Homebrew archive record")
    path, record = candidates[0]
    assert record["sourceCommit"] == commit
    assert re.fullmatch(r"\d+\.\d+\.\d+", record["version"])
    assert re.fullmatch(r"[a-f0-9]{64}", record["sha256"])
    archive = retained_file(artifacts, record["filename"], ".tar.gz")
    content = archive.read_bytes()
    assert len(content) == record["size"] and hashlib.sha256(content).hexdigest() == record["sha256"]
    return archive, path, record


class HomebrewRunner(Runner):
    def __init__(self, args):
        # Existing deterministic provider/tools/TUI/cancel/resume implementation.
        args.mode = "deterministic"
        args.update_baselines = False
        args.output = safe_directory(args.output)
        if getattr(args, "artifacts", None) is not None:
            args.artifacts = safe_directory(args.artifacts)
        super().__init__(args)
        self.payload = None
        self.tools = None
        self.fixture_root = None

    def save(self):
        self.args.mode = "homebrew"
        try:
            super().save()
        finally:
            self.args.mode = "deterministic"

    def fixture_directory(self, executable):
        # Resolve installed SDK from the retained app, never the bundle/repository.
        return self.fixture_root

    def environment(self, root):
        root.mkdir(parents=True, exist_ok=True)
        env = super().environment(root)
        env["PATH"] = str(self.tools)
        env["DIFFEX_OFFLINE"] = "1"
        env["DIFFEX_SKIP_VERSION_CHECK"] = "1"
        return env

    def brew_command(self, args):
        result = subprocess.run([self.brew, *args], env=self.brew_env, cwd="/tmp", capture_output=True,
                                text=True, timeout=300)
        # Do not publish brew stdout/stderr, local paths, ambient config or SDK secrets.
        assert result.returncode == 0, "Real brew command failed: " + args[0]
        return result.stdout.strip()

    def run(self):
        with tempfile.TemporaryDirectory(prefix="diffex-homebrew-", dir="/tmp") as directory:
            work = Path(directory)
            archive, record_path, record = choose_record(self.args.artifacts, self.args.commit)
            self.hashes = {record["filename"]: record["sha256"]}
            self.brew = shutil.which("brew")
            assert self.brew and os.getuid() != 0, "Preprovisioned non-root Homebrew required"
            brew_home = work / "brew-home"
            brew_home.mkdir()
            self.brew_env = {"PATH": os.environ["PATH"], "HOME": str(brew_home),
                             "USER": os.environ.get("USER", "linuxbrew"), "LANG": "C.UTF-8",
                             "HOMEBREW_NO_AUTO_UPDATE": "1", "HOMEBREW_NO_ANALYTICS": "1",
                             "HOMEBREW_NO_INSTALL_CLEANUP": "1", "HOMEBREW_NO_INSTALL_FROM_API": "1",
                             "HOMEBREW_CACHE": str(work / "brew-cache"),
                             "HOMEBREW_LOGS": str(work / "brew-logs")}
            self.tools = work / "tools"
            self.tools.mkdir()
            for tool in TOOLS:
                source = shutil.which(tool)
                if source:
                    (self.tools / tool).symlink_to(Path(source).resolve())
            assert all(not (self.tools / name).exists() for name in ("node", "npm", "npx", "bun"))
            # Brew's own dependency/runtime PATH is separate from every product invocation.
            tap = "diffexai/tap"
            assert tap not in self.brew_command(["tap"]).splitlines(), "Snapshot must not contain the candidate tap"
            assert not any(line.split()[0] == "diffex" for line in self.brew_command(["list", "--formula", "--versions"]).splitlines()), "Snapshot must not contain diffex"
            source = work / "tap"
            (source / "Formula").mkdir(parents=True)
            formula = source / "Formula/diffex.rb"
            formula.write_text(candidate_formula(archive, record))
            for command in (["git", "init", str(source)], ["git", "-C", str(source), "add", "Formula/diffex.rb"],
                            ["git", "-C", str(source), "-c", "user.name=Acceptance fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "Local candidate fixture"]):
                subprocess.run(command, check=True, capture_output=True, timeout=15, env=self.brew_env)
            tapped = installed = False
            try:
                def install(evidence):
                    nonlocal tapped, installed
                    self.brew_command(["tap", tap, str(source)])
                    tapped = True
                    self.brew_command(["install", "--formula", f"{tap}/diffex"])
                    installed = True
                    prefix = Path(self.brew_command(["--prefix", f"{tap}/diffex"]))
                    self.payload = (prefix / "libexec/diffex").resolve()
                    verified_inventory = verify_payload_inventory(self.payload, record)
                    assert json.loads((self.payload.parent / ".diffex-homebrew.json").read_text()) == MARKER
                    self.executable = str(prefix / "bin/diffex")
                    if not getattr(self.args, "lifecycle_only", False):
                        self.fixture_root = work / "external-fixtures"
                        link_fixture_modules(self.payload, self.fixture_root)
                    product_env = self.environment(work / "installation")
                    project = work / "installation/project"
                    for name, command, expected in (("help", ["--help"], "Usage"), ("version", ["--version"], record["version"]),
                                                    ("models", ["--list-models"], None)):
                        command_evidence = evidence / name
                        command_evidence.mkdir()
                        output = self.process(self.executable, command, product_env, project, command_evidence)
                        assert output.strip() and (expected is None or expected in output), "Installed command output mismatch"
                    protected = [self.payload, Path(product_env["HOME"]), Path(product_env["DIFFEX_CODING_AGENT_DIR"]), work / "installation/project"]
                    before_update = [fingerprint(path) for path in protected]
                    for name, command in (("update", ["update"]), ("forced-update", ["update", "--self", "--force"])):
                        command_evidence = evidence / name
                        command_evidence.mkdir()
                        output = self.process(self.executable, command, product_env, project, command_evidence)
                        assert "brew upgrade diffexai/tap/diffex" in output
                    assert [fingerprint(path) for path in protected] == before_update, "Owned update changed payload/user/project state"
                    verified_inventory = verify_payload_inventory(self.payload, record)
                    (evidence / "lifecycle.json").write_text(json.dumps({"brew": "real", "source": "trusted local file candidate", "revision": 0,
                        "commands": ["help", "version", "models"], "ownedUpdateNoMutation": True, "payloadInventory": verified_inventory}))
                if not self.scenario("homebrew-formula-install", install, "configuration"):
                    return False

                def archive_acceptance(evidence):
                    # Harness Node only; tested CLI subprocesses use restricted tools PATH.
                    result = subprocess.run(["node", str(HERE.parent / "homebrew-acceptance.mjs"), str(archive), str(record_path), str(evidence)],
                                            capture_output=True, timeout=240, env=self.brew_env)
                    assert result.returncode == 0, "Retained archive acceptance failed"
                    summary = json.loads((evidence / "homebrew-acceptance.json").read_text())
                    assert summary["status"] == "passed" and summary["cleanup"] is True
                if not getattr(self.args, "lifecycle_only", False):
                    self.scenario("homebrew-retained-archive", archive_acceptance, "configuration")
                    self.deterministic(self.executable, "homebrew", include_artifact_terminal=False)

                # User data is outside the keg; retain real app-created session data plus canaries.
                user = work / "user-data"
                env = self.environment(user)
                # Match brew's HOME and the default user-data location, so a formula
                # accidentally deleting ~/.diffex would fail these assertions.
                agent = brew_home / ".diffex/agent"
                env["HOME"] = str(brew_home)
                env["DIFFEX_CODING_AGENT_DIR"] = str(agent)
                for name in ("auth.json", "settings.json", "sessions/retention.jsonl", "extensions/retention.ts", "npm/node_modules/diffex-homebrew-fixture/package.json"):
                    target = agent / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(json.dumps({"fixture": "retain-me"}) + "\n")
                session_evidence = self.output / "homebrew-terminal-tools-cancel-resume/sessions"
                if session_evidence.exists():
                    shutil.copytree(session_evidence, agent / "sessions/real-conversation")
                before = {path.relative_to(agent).as_posix(): path.read_bytes() for path in agent.rglob("*") if path.is_file()}

                def retain():
                    assert all((agent / name).read_bytes() == content for name, content in before.items()), "User data was changed"

                def upgrade(evidence):
                    tap_root = Path(self.brew_command(["--repository", tap]))
                    (tap_root / "Formula/diffex.rb").write_text(candidate_formula(archive, record, revision=1))
                    old_payload = self.payload
                    self.brew_command(["upgrade", "--formula", f"{tap}/diffex"])
                    prefix = Path(self.brew_command(["--prefix", f"{tap}/diffex"]))
                    self.payload = (prefix / "libexec/diffex").resolve()
                    assert self.payload != old_payload, "Brew did not upgrade to a distinct revision keg"
                    verified_inventory = verify_payload_inventory(self.payload, record)
                    self.process(str(prefix / "bin/diffex"), ["--version"], env, work, evidence)
                    verified_inventory = verify_payload_inventory(self.payload, record)
                    retain()
                    (evidence / "lifecycle.json").write_text(json.dumps({"brew": "real", "revision": 1,
                        "upgrade": "same retained bytes; formula revision fixture, not a second released version", "userDataRetained": True,
                        "payloadInventory": verified_inventory}))
                self.scenario("homebrew-formula-upgrade-retention", upgrade)

                def uninstall(evidence):
                    nonlocal installed
                    self.brew_command(["uninstall", "--force", f"{tap}/diffex"])
                    installed = False
                    assert not any(line.split()[0] == "diffex" for line in self.brew_command(["list", "--formula", "--versions"]).splitlines())
                    retain()
                    (evidence / "lifecycle.json").write_text(json.dumps({"brew": "real", "uninstalled": True, "userDataRetained": True}))
                self.scenario("homebrew-formula-uninstall-retention", uninstall)
            finally:
                if installed:
                    self.brew_command(["uninstall", "--force", f"{tap}/diffex"])
                if tapped:
                    self.brew_command(["untap", tap])
                # Never publish home, npm cache/config, auth files or raw command output.
        self.save()
        return bool(self.results) and all(item["outcome"] == "passed" for item in self.results)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=safe_directory, required=True)
    parser.add_argument("--output", type=safe_directory, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--mode", choices=["homebrew"], default="homebrew")
    parser.add_argument("--lifecycle-only", action="store_true",
                        help="Native real-brew install/upgrade/uninstall; no Daytona SDK, tmux or TUI scenarios required")
    args = parser.parse_args()
    runner = HomebrewRunner(args)
    try:
        passed = runner.run()
    except Exception:
        runner.scenario("homebrew-prerequisites-or-cleanup", lambda _: (_ for _ in ()).throw(AssertionError("Homebrew prerequisite or cleanup failure")), "configuration")
        passed = False
    raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
