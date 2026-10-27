#!/usr/bin/env python3
"""Independent Daytona behavior orchestration (Python 3.11+, no Harbor).

Workflow contract::

    python daytona_runner.py prepare-snapshot --name diffex-behaviors-toolchain --output snapshot-record
    python daytona_runner.py run --run-id "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \
        --artifacts retained-release --bundle behavior-bundle.tar.gz \
        --snapshot diffex-behaviors-toolchain --output daytona-results \
        --mode deterministic --commit "$GITHUB_SHA"
    python daytona_runner.py recover --output daytona-results

Always retain/upload the entire output directory, including state.json. Recovery never
creates a replacement or replays a possibly-started command. OPENAI_API_KEY is read only
for live mode and passed through process.exec(env=...), never sandbox env or metadata.
DAYTONA_API_KEY is used by the local SDK only. Installed.py owns artifact installation.

SDK 0.226.1 API and lifecycle semantics inspected at:
https://www.daytona.io/docs/en/sandboxes/#wall-clock-ttl
https://www.daytona.io/docs/en/python-sdk/sync/daytona/
`ttl_minutes=45` destroys in every state; auto_delete_interval alone is NOT a TTL.
Snapshots inherit resources, so both snapshot and sandbox resources are checked.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import tarfile
import tempfile
import time
from typing import Iterator
import uuid
import xml.etree.ElementTree as ET

from daytona import (
    CreateSandboxFromSnapshotParams, CreateSnapshotParams, Daytona,
    DaytonaNotFoundError, Image, ListSandboxesQuery, Resources, Sandbox,
)

SDK_VERSION = "0.226.1"
TTL_MINUTES = 45
RESOURCES = {"cpu": 2, "memory": 4, "disk": 8}
REMOTE_BUNDLE = "/tmp/diffex-behaviors"
REMOTE_RELEASE = "/tmp/diffex-release"
REMOTE_EVIDENCE = "/tmp/diffex-evidence"
INSTALLED = f"{REMOTE_BUNDLE}/scripts/daytona-behaviors/installed.py"
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_EVIDENCE_BYTES = 512 * 1024 * 1024

# Uploaded scripts contain no credentials, even for live mode.
EXTRACT_SCRIPT = '''import hashlib, os, pathlib, shutil, stat, sys, tarfile
# Verify BOTH uploads before extracting either input.
for archive, expected in zip(("/tmp/diffex-release.tar.gz", "/tmp/diffex-bundle.tar.gz"), sys.argv[1:], strict=True):
    with open(archive, "rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise ValueError("uploaded input SHA256 mismatch")
for archive, destination in (("/tmp/diffex-release.tar.gz", "/tmp/diffex-release"),
                             ("/tmp/diffex-bundle.tar.gz", "/tmp/diffex-behaviors")):
    root = pathlib.Path(destination)
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as source:
        for member in source:
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not (member.isdir() or member.isfile()):
                raise ValueError("unsafe archive member")
            target = root.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            else:
                with source.extractfile(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(member.mode & 0o777)
'''
MANIFEST_SCRIPT = '''import hashlib, json, os, pathlib, stat
root = pathlib.Path("/tmp/diffex-evidence")
files = []
for directory, dirs, names in os.walk(root, followlinks=False):
    dirs[:] = sorted(d for d in dirs if not pathlib.Path(directory, d).is_symlink())
    for name in sorted(names):
        path = pathlib.Path(directory, name)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("nonregular evidence")
        if info.st_size > 67108864:
            raise ValueError("evidence file too large")
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files.append({"path": path.relative_to(root).as_posix(), "size": info.st_size, "sha256": digest})
print(json.dumps(files))
'''


class OrchestrationError(Exception):
    """Safe, locally constructed diagnostic (never includes credentials)."""


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_relative(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if not name or not path.parts or path.is_absolute() or ".." in path.parts or "\\" in name:
        raise OrchestrationError("unsafe artifact path")
    return path


def archive_directory(source: Path, destination: Path) -> None:
    """Archive only explicit inputs; never follow symlinks or read ambient config."""
    if not source.is_dir() or source.is_symlink():
        raise OrchestrationError("input must be a regular directory")
    with tarfile.open(destination, "w:gz") as archive:
        for path in sorted(source.rglob("*")):
            name = path.relative_to(source).as_posix()
            safe_relative(name)
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise OrchestrationError("input contains links or special files")
            if path.name == ".env" or path.name.startswith(".env.") or path.name in (".npmrc", ".netrc"):
                raise OrchestrationError("input contains credential configuration")
            archive.add(path, arcname=name, recursive=False)


def validate_archive(path: Path) -> None:
    with tarfile.open(path) as archive:
        for member in archive:
            safe_relative(member.name)
            if not (member.isfile() or member.isdir()):
                raise OrchestrationError("bundle contains links or special files")
            name = PurePosixPath(member.name).name
            if name == ".env" or name.startswith(".env.") or name in (".npmrc", ".netrc"):
                raise OrchestrationError("bundle contains credential configuration")


@dataclass
class State:
    run_id: str
    name: str
    labels: dict[str, str]
    commit: str
    mode: str
    snapshot: str
    created_at: float
    deadline: float
    sandbox_id: str | None = None
    create_attempted: bool = False
    create_returned: bool = False
    launch_attempted: bool = False
    execution: str = "pending"
    cleanup: str = "pending"
    exit_code: int | None = None
    errors: list[str] = field(default_factory=list)
    downloaded: dict[str, str] = field(default_factory=dict)
    inputs: dict[str, str] = field(default_factory=dict)

    def save(self, output: Path) -> None:
        atomic_json(output / "state.json", asdict(self))

    def error(self, stage: str, error: Exception) -> None:
        # SDK error bodies can contain HTTP request details. Do not serialize them.
        detail = str(error) if isinstance(error, OrchestrationError) else type(error).__name__
        self.errors.append(f"{stage}: {detail}")


@contextmanager
def termination_handlers() -> Iterator[None]:
    def terminate(signum: int, _frame: object) -> None:
        # A second TERM must not interrupt the independent cleanup/final report.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise OrchestrationError(f"interrupted by signal {signum}")
    previous = {sig: signal.signal(sig, terminate) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


class Runner:
    def __init__(self, client: Daytona, output: Path, state: State, poll_seconds: float = 5):
        self.client = client
        self.output = output.resolve()
        self.state = state
        self.poll_seconds = poll_seconds

    def owned(self, sandbox: Sandbox) -> Sandbox:
        if sandbox.name != self.state.name or any(
            sandbox.labels.get(key) != value for key, value in self.state.labels.items()
        ):
            raise OrchestrationError("sandbox identity/ownership mismatch; refusing access or deletion")
        if self.state.sandbox_id and sandbox.id != self.state.sandbox_id:
            raise OrchestrationError("sandbox ID changed; refusing access or deletion")
        return sandbox

    def lookup(self) -> Sandbox:
        return self.owned(self.client.get(self.state.sandbox_id or self.state.name, request_timeout=10))

    def create(self) -> Sandbox:
        snapshot = self.client.snapshot.get(self.state.snapshot)
        self.check_resources(snapshot)
        if str(snapshot.state) != "active":
            raise OrchestrationError("snapshot must already be active")
        self.state.create_attempted = True
        self.state.save(self.output)  # durable name + labels BEFORE the only create request
        sandbox = self.client.create(CreateSandboxFromSnapshotParams(
            name=self.state.name, snapshot=self.state.snapshot, labels=dict(self.state.labels),
            public=False, auto_stop_interval=0, auto_pause_interval=0,
            auto_delete_interval=0, ttl_minutes=TTL_MINUTES,
        ), timeout=180)
        self.owned(sandbox)
        self.state.sandbox_id = sandbox.id
        self.state.create_returned = True
        self.state.save(self.output)
        self.check_resources(sandbox)
        return sandbox

    @staticmethod
    def check_resources(resource: object) -> None:
        # Snapshot DTO calls memory `mem`; Sandbox exposes `memory`.
        actual = {"cpu": getattr(resource, "cpu", None),
                  "memory": getattr(resource, "memory", getattr(resource, "mem", None)),
                  "disk": getattr(resource, "disk", None)}
        if actual != RESOURCES:
            raise OrchestrationError(f"expected resources {RESOURCES}, got {actual}")

    @staticmethod
    def execute(sandbox: Sandbox, command: str, env: dict[str, str] | None = None) -> str:
        result = sandbox.process.exec(command, env=env, timeout=30)
        if result.exit_code != 0:
            raise OrchestrationError("remote orchestration command failed")
        return result.result

    def stage(self, sandbox: Sandbox, artifacts: Path, bundle: Path) -> None:
        with tempfile.TemporaryDirectory(prefix="diffex-daytona-") as directory:
            temp = Path(directory)
            release_archive = temp / "release.tar.gz"
            archive_directory(artifacts, release_archive)
            bundle_archive = bundle
            if bundle.is_dir():
                bundle_archive = temp / "bundle.tar.gz"
                archive_directory(bundle, bundle_archive)
            validate_archive(bundle_archive)
            self.state.inputs = {"release_sha256": sha256(release_archive),
                                 "bundle_sha256": sha256(bundle_archive)}
            self.state.save(self.output)
            sandbox.fs.upload_file(str(release_archive), "/tmp/diffex-release.tar.gz", timeout=120)
            sandbox.fs.upload_file(str(bundle_archive), "/tmp/diffex-bundle.tar.gz", timeout=120)
        sandbox.fs.upload_file(EXTRACT_SCRIPT.encode(), "/tmp/diffex-extract.py", timeout=30)
        self.execute(sandbox, "python3 /tmp/diffex-extract.py "
                     + self.state.inputs["release_sha256"] + " " + self.state.inputs["bundle_sha256"])
        self.execute(sandbox, f"test -f {INSTALLED} && mkdir -p {REMOTE_EVIDENCE}")

    def launch(self, sandbox: Sandbox, live_key: str | None) -> None:
        argv = ["python3", INSTALLED, "--artifacts", REMOTE_RELEASE,
                "--output", REMOTE_EVIDENCE, "--mode", self.state.mode,
                "--commit", self.state.commit]
        script = (
            "import json, os, pathlib, subprocess\n"
            f"root = pathlib.Path({REMOTE_EVIDENCE!r})\n"
            "with (root / 'installed.log').open('wb') as log:\n"
            f"    result = subprocess.run({argv!r}, cwd={REMOTE_BUNDLE!r}, stdout=log, stderr=subprocess.STDOUT)\n"
            "temporary = root / '.orchestration-exit.tmp'\n"
            "temporary.write_text(json.dumps({'exit_code': result.returncode}))\n"
            "temporary.replace(root / '.orchestration-exit.json')\n"
        )
        sandbox.fs.upload_file(script.encode(), "/tmp/diffex-launch.py", timeout=30)
        self.state.launch_attempted = True
        self.state.execution = "running"
        self.state.save(self.output)  # ambiguous exec is never replayed by recover
        env = {"OPENAI_API_KEY": live_key} if self.state.mode == "live" and live_key else {}
        self.execute(sandbox,
                     "nohup python3 /tmp/diffex-launch.py </dev/null "
                     f">{REMOTE_EVIDENCE}/launcher.log 2>&1 &", env=env)

    def collect(self, sandbox: Sandbox) -> None:
        manifest = json.loads(self.execute(sandbox, "python3 -c " + shlex.quote(MANIFEST_SCRIPT)))
        if not isinstance(manifest, list):
            raise OrchestrationError("invalid evidence manifest")
        total = 0
        evidence = self.output / "evidence"
        evidence.mkdir(exist_ok=True)
        for entry in manifest:
            name = entry["path"]
            relative = safe_relative(name)
            size, digest = entry["size"], entry["sha256"]
            total += size
            if size < 0 or size > MAX_FILE_BYTES or total > MAX_EVIDENCE_BYTES:
                raise OrchestrationError("evidence exceeds download limits")
            target = evidence.joinpath(*relative.parts)
            # Do not follow pre-existing local symlinks, including parent directories.
            if any(path.is_symlink() for path in [target, *target.parents]):
                raise OrchestrationError("local evidence symlink")
            if self.state.downloaded.get(name) == digest and target.is_file() and sha256(target) == digest:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + ".download")
            received = 0
            try:
                with temporary.open("wb") as stream:
                    for chunk in sandbox.fs.download_file_stream(f"{REMOTE_EVIDENCE}/{name}", timeout=30):
                        received += len(chunk)
                        if received > MAX_FILE_BYTES:
                            raise OrchestrationError("evidence grew beyond download limit")
                        stream.write(chunk)
                if received != size or sha256(temporary) != digest:
                    # A log may change while downloading. Keep the previous complete copy.
                    continue
                temporary.replace(target)
                self.state.downloaded[name] = digest
                self.state.save(self.output)
            finally:
                temporary.unlink(missing_ok=True)

    def poll(self, sandbox: Sandbox, deadline: float) -> None:
        while True:
            try:
                self.collect(sandbox)
                exit_file = self.output / "evidence" / ".orchestration-exit.json"
                if exit_file.is_file():
                    code = json.loads(exit_file.read_text())["exit_code"]
                    if not isinstance(code, int):
                        raise OrchestrationError("invalid installed runner exit code")
                    self.state.exit_code = code
                    self.state.execution = "passed" if code == 0 else "failed"
                    self.state.save(self.output)
                    return
            except Exception as error:
                self.state.error("evidence", error)
                self.state.save(self.output)
            if time.time() >= deadline:
                raise OrchestrationError("evidence/execution deadline exceeded")
            time.sleep(min(self.poll_seconds, max(0, deadline - time.time())))

    def cleanup(self, attempts: int = 6) -> None:
        if not self.state.create_attempted:
            self.state.cleanup = "not-needed"
            self.state.save(self.output)
            return
        for attempt in range(attempts):
            try:
                sandbox = self.lookup()
                self.state.sandbox_id = sandbox.id
                self.state.save(self.output)
                try:
                    self.client.delete(sandbox, timeout=15, wait=False)
                except Exception as error:
                    self.state.error("delete-request", error)
            except DaytonaNotFoundError:
                pass
            except Exception as error:
                self.state.error("cleanup-lookup", error)
            # Independent fresh reads, even when deletion raised or claimed success.
            try:
                identifiers = {self.state.name}
                if self.state.sandbox_id:
                    identifiers.add(self.state.sandbox_id)
                for identifier in identifiers:
                    try:
                        found = self.client.get(identifier, request_timeout=10)
                    except DaytonaNotFoundError:
                        continue
                    self.owned(found)
                    raise OrchestrationError("sandbox still visible after deletion")
                remaining = list(self.client.list(ListSandboxesQuery(labels=self.state.labels), request_timeout=10))
                if remaining:
                    raise OrchestrationError("sandbox labels still visible after deletion")
                # A 404 immediately after an ambiguous POST is not proof it cannot appear later.
                if not self.state.sandbox_id:
                    raise OrchestrationError("creation unresolved; recover by saved name/labels; TTL bounds lifetime")
                self.state.cleanup = "confirmed"
                self.state.save(self.output)
                return
            except Exception as error:
                self.state.error("cleanup-confirm", error)
            self.state.cleanup = "unconfirmed"
            self.state.save(self.output)
            if attempt + 1 < attempts:
                time.sleep(self.poll_seconds)

    def report(self) -> int:
        results_path = self.output / "evidence" / "results.json"
        installed: dict[str, object] = {}
        try:
            if results_path.exists():
                installed = json.loads(results_path.read_text())
        except (ValueError, OSError):
            self.state.errors.append("report: invalid installed results.json")
        reports_complete = (
            results_path.is_file() and (self.output / "evidence" / "results.xml").is_file()
            and installed.get("outcome") in ("passed", "failed")
        )
        success = (self.state.execution == "passed" and self.state.exit_code == 0
                   and installed.get("outcome") == "passed" and reports_complete
                   and self.state.cleanup in ("confirmed", "not-needed"))
        report = {"outcome": "passed" if success else "failed", "category": "daytona",
                  "input_hashes": self.state.inputs, "run_id": self.state.run_id,
                  "commit": self.state.commit, "mode": self.state.mode, "name": self.state.name,
                  "sandbox_id": self.state.sandbox_id, "execution": self.state.execution,
                  "exit_code": self.state.exit_code, "installed_outcome": installed.get("outcome"),
                  "reports_complete": reports_complete, "cleanup": self.state.cleanup,
                  "duration_seconds": max(0, time.time() - self.state.created_at),
                  "artifact_hashes": self.state.downloaded, "errors": self.state.errors}
        atomic_json(self.output / "orchestration.json", report)
        suite = ET.Element("testsuite", name="daytona-orchestration", tests="3", failures=str(sum((
            self.state.execution != "passed", not reports_complete or installed.get("outcome") != "passed",
            self.state.cleanup not in ("confirmed", "not-needed")))))
        for name, passed, detail in (
            ("execution", self.state.execution == "passed", self.state.execution),
            ("installed-evidence", reports_complete and installed.get("outcome") == "passed", str(installed.get("outcome"))),
            ("cleanup", self.state.cleanup in ("confirmed", "not-needed"), self.state.cleanup),
        ):
            case = ET.SubElement(suite, "testcase", name=name, classname="daytona")
            if not passed:
                ET.SubElement(case, "failure", message=detail).text = "\n".join(self.state.errors)
        ET.ElementTree(suite).write(self.output / "orchestration.xml", encoding="utf-8", xml_declaration=True)
        self.state.save(self.output)
        return 0 if success else 1

    def run(self, artifacts: Path, bundle: Path, live_key: str | None) -> int:
        try:
            sandbox = self.create()
            self.stage(sandbox, artifacts, bundle)
            self.launch(sandbox, live_key)
            self.poll(sandbox, self.state.deadline)
        except Exception as error:
            self.state.execution = "failed"
            self.state.error("run", error)
        finally:
            if self.state.launch_attempted:
                try:
                    self.collect(self.lookup())
                except Exception as error:
                    self.state.error("final-evidence", error)
            try:
                self.cleanup()
            except Exception as error:
                self.state.cleanup = "unconfirmed"
                self.state.error("cleanup", error)
            self.state.save(self.output)
        return self.report()

    def recover(self, wait_seconds: float) -> int:
        try:
            if self.state.create_attempted and self.state.cleanup != "confirmed":
                sandbox = self.lookup()
                if self.state.launch_attempted:
                    self.poll(sandbox, min(self.state.deadline, time.time() + wait_seconds))
        except DaytonaNotFoundError:
            pass
        except Exception as error:
            self.state.error("recover-evidence", error)
        finally:
            try:
                self.cleanup()
            except Exception as error:
                self.state.cleanup = "unconfirmed"
                self.state.error("recover-cleanup", error)
        return self.report()


def prepare_snapshot(client: Daytona, name: str, output: Path) -> int:
    dockerfile = Path(__file__).with_name("Dockerfile")
    record: dict[str, object] = {"name": name, "dockerfile_sha256": sha256(dockerfile),
                                "resources": RESOURCES, "status": "requested"}
    output.mkdir(parents=True, exist_ok=False)
    atomic_json(output / "snapshot.json", record)
    try:
        # No replacement or delete: an existing name or ambiguous POST requires inspection.
        snapshot = client.snapshot.create(CreateSnapshotParams(
            name=name, image=Image.from_dockerfile(dockerfile, strict_context=True),
            resources=Resources(**RESOURCES),
        ), timeout=1200)
        Runner.check_resources(snapshot)
        record.update(status="active", id=snapshot.id)
        return 0
    except Exception as error:
        record.update(status="failed-or-ambiguous", error=type(error).__name__)
        return 1
    finally:
        atomic_json(output / "snapshot.json", record)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--artifacts", type=Path, required=True)
    run.add_argument("--bundle", type=Path, required=True)
    run.add_argument("--snapshot", required=True)
    run.add_argument("--run-id", required=True)
    run.add_argument("--commit", required=True)
    run.add_argument("--mode", choices=("deterministic", "live"), required=True)
    run.add_argument("--timeout-seconds", type=int, default=2100)
    run.add_argument("--live-key-env", choices=("OPENAI_API_KEY",), default="OPENAI_API_KEY")
    recover = commands.add_parser("recover")
    recover.add_argument("--wait-seconds", type=int, default=0)
    snapshot = commands.add_parser("prepare-snapshot")
    snapshot.add_argument("--name", required=True)
    for command in (run, recover, snapshot):
        command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if version("daytona") != SDK_VERSION:
        parser.error(f"install requirements.txt: daytona=={SDK_VERSION} required")
    if args.command == "run":
        if not re.fullmatch(r"[0-9a-fA-F]{40}", args.commit):
            parser.error("--commit must be a full 40-character commit SHA")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", args.run_id):
            parser.error("--run-id must be 1-80 alphanumeric, dash or underscore characters")
        if not 1 <= args.timeout_seconds <= 2400:
            parser.error("--timeout-seconds must be 1..2400, below the 45-minute wall-clock TTL")
        if not args.artifacts.is_dir() or not args.bundle.exists():
            parser.error("artifacts directory and bundle must exist")
        live_key = os.environ.get(args.live_key_env) if args.mode == "live" else None
        if args.mode == "live" and not live_key:
            parser.error("live mode requires OPENAI_API_KEY")
        args.output.mkdir(parents=True, exist_ok=False)
        token = uuid.uuid4().hex
        now = time.time()
        state = State(run_id=args.run_id, name=f"diffex-behaviors-{args.run_id[:32]}-{token[:12]}",
                      labels={"diffex-purpose": "installed-behaviors", "diffex-run": token,
                              "diffex-run-id": args.run_id, "diffex-commit": args.commit},
                      commit=args.commit, mode=args.mode, snapshot=args.snapshot,
                      created_at=now, deadline=now + args.timeout_seconds)
        state.save(args.output)
        with termination_handlers():
            return Runner(Daytona(), args.output, state).run(args.artifacts, args.bundle, live_key)
    if args.command == "recover":
        if args.wait_seconds < 0 or args.wait_seconds > 2400:
            parser.error("--wait-seconds must be 0..2400")
        state = State(**json.loads((args.output / "state.json").read_text()))
        with termination_handlers():
            return Runner(Daytona(), args.output, state).recover(args.wait_seconds)
    with termination_handlers():
        return prepare_snapshot(Daytona(), args.name, args.output)


if __name__ == "__main__":
    raise SystemExit(main())
