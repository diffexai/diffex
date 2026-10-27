"""Installed-package acceptance. No repository imports, provider keys in evidence, or UI mocks."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent


def read_events(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


class Terminal:
    """Real tmux PTY, isolated server, bounded state waits, and incremental capture."""
    def __init__(self, executable, args, env, project, evidence, deadline):
        self.socket = "diffex-behavior-" + uuid.uuid4().hex
        self.evidence, self.deadline = evidence, deadline
        self.env = env
        (evidence / "tmux.conf").write_text("set -g extended-keys on\nset -gq extended-keys-format csi-u\n")
        self.command("new-session", "-d", "-s", "behavior", "-x", "80", "-y", "24",
                     "-c", str(project),
                     " ".join(shlex.quote(a) for a in [executable, *args]))
        self.command("set-option", "-g", "remain-on-exit", "on")

    def command(self, *args):
        result = subprocess.run(["tmux", "-f", str(self.evidence / "tmux.conf"), "-L", self.socket, *args], capture_output=True, text=True,
                                timeout=10, env=self.env)
        if result.returncode:
            raise RuntimeError("tmux: " + result.stderr)
        return result.stdout

    def send(self, text):
        self.command("send-keys", "-l", text)
        self.command("send-keys", "Enter")

    def capture(self):
        screen = self.command("capture-pane", "-p", "-S", "-2000")
        (self.evidence / "terminal.txt").write_text(screen.replace(self.env.get("OPENAI_API_KEY", "\0"), "[REDACTED]"))
        return screen

    def wait(self, text, seconds=30):
        end = min(self.deadline, time.monotonic() + seconds)
        while time.monotonic() < end:
            screen = self.capture()
            if text in screen:
                return screen
            time.sleep(.1)
        raise AssertionError(f"Terminal did not reach {text!r} within bounded wait")

    def settled(self, record, previous, seconds=30):
        end = min(self.deadline, time.monotonic() + seconds)
        while time.monotonic() < end:
            self.capture()
            if sum(e["type"] == "settled" for e in read_events(record)) > previous:
                return
            time.sleep(.1)
        raise AssertionError("Agent did not settle before deadline")

    def screen(self, name, size, baseline):
        width, height = size
        self.command("resize-window", "-x", str(width), "-y", str(height))
        # Wait for a stable rendered layout, not an arbitrary startup sleep.
        end = min(self.deadline, time.monotonic() + 5)
        previous, stable = None, 0
        while time.monotonic() < end:
            screen = self.command("capture-pane", "-p")
            stable = stable + 1 if screen == previous else 0
            previous = screen
            if stable >= 3:
                break
            time.sleep(.1)
        assert stable >= 3, "Terminal layout never stabilized"
        (self.evidence / (name + ".txt")).write_text(screen)
        normalized = normalize_screen(screen, self.env)
        (self.evidence / (name + ".normalized.txt")).write_text(normalized)
        expected = HERE / "baselines" / (name + ".txt")
        if baseline:
            expected.parent.mkdir(exist_ok=True)
            expected.write_text(normalized)
        assert expected.exists(), f"Missing reviewed baseline: {expected.name}"
        assert normalized == expected.read_text(), f"Layout differs: {expected.name} (see captures)"
        assert len(screen.splitlines()) == height, "Incorrect terminal height"
        assert all(len(line) <= width for line in screen.splitlines()), "Terminal overflow"

    def exit(self):
        self.send("/exit")
        end = min(self.deadline, time.monotonic() + 10)
        while time.monotonic() < end:
            self.capture()
            dead = self.command("display-message", "-p", "#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}").strip()
            if dead.startswith("1:"):
                # Older tmux may observe EOF before waitpid supplies status.
                # A dead pane alone is not a completed or successful exit.
                _, status, signal = dead.split(":", 2)
                if status or signal:
                    assert status == "0" and not signal, f"Unclean terminal exit: {dead}"
                    return
            time.sleep(.1)
        raise AssertionError("Terminal failed to exit")

    def close(self):
        try:
            self.capture()
        finally:
            self.command("kill-server")


def normalize_screen(screen, env):
    # Only machine-specific identity/timing is normalized; whitespace and geometry remain exact.
    screen = screen.replace(str(Path(env["DIFFEX_PROJECT"]).resolve()), "<PROJECT>")
    screen = screen.replace(env["HOME"], "<HOME>").replace(env["DIFFEX_PROJECT"], "<PROJECT>")
    screen = re.sub(r"Diffex v[\w.\-]+", "Diffex v<VERSION>", screen)
    screen = re.sub(r"\b\d+(?:\.\d+)?[km]?/\d+(?:\.\d+)?[km]?", "<TOKENS>", screen)
    screen = re.sub(r"\b\d+(?:\.\d+)?(?:ms|s)\b", "<TIME>", screen)
    return screen


class Runner:
    def __init__(self, args):
        self.args = args
        self.output = args.output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.results = []
        self.hashes = {}
        self.deadline = time.monotonic() + (180 if args.mode == "live" else 1200)
        self.secrets = [os.environ.get("OPENAI_API_KEY", "")] if args.mode == "live" else []

    def save(self):
        result = {"schemaVersion": 1, "commit": self.args.commit, "mode": self.args.mode,
                  "artifactHashes": self.hashes, "scenarios": self.results,
                  "outcome": "passed" if self.results and all(r["outcome"] == "passed" for r in self.results) else "failed"}
        write_json(self.output / "results.json", result)
        suite = ET.Element("testsuite", name="installed-" + self.args.mode, tests=str(len(self.results)),
                           failures=str(sum(r["outcome"] != "passed" for r in self.results)))
        for r in self.results:
            case = ET.SubElement(suite, "testcase", name=r["id"], time=str(r["duration"]), classname=r["category"])
            if r["outcome"] != "passed":
                ET.SubElement(case, "failure", message=r.get("error", "failed")).text = r.get("error", "failed")
            ET.SubElement(case, "system-out").text = json.dumps({"commit": self.args.commit, "artifactHashes": self.hashes, "evidence": r["evidence"]})
        ET.ElementTree(suite).write(self.output / "results.xml", encoding="unicode")

    def scenario(self, identity, operation, category="product"):
        evidence = self.output / identity
        evidence.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        item = {"id": identity, "commit": self.args.commit, "artifactHashes": self.hashes,
                "outcome": "failed", "category": category, "evidence": [str(evidence.relative_to(self.output))]}
        try:
            assert time.monotonic() < self.deadline, "Run deadline exceeded"
            operation(evidence)
            item["outcome"] = "passed"
        except Exception as error:
            message = str(error)
            for secret in self.secrets:
                if secret:
                    message = message.replace(secret, "[REDACTED]")
            item["error"] = message
            # Availability/configuration is distinct from an assertion about product behavior.
            events = [event for file in evidence.glob("**/events.jsonl") for event in read_events(file)]
            statuses = [event["status"] for event in events if event["type"] == "response"]
            if any(s in (400, 401, 403, 404) for s in statuses):
                item["category"] = "configuration"
            elif any(s == 429 or s >= 500 for s in statuses) or any(e["type"] == "provider-error" for e in events):
                item["category"] = "provider"
        finally:
            item["duration"] = round(time.monotonic() - started, 3)
            self.results.append(item)
            self.save()
        return item["outcome"] == "passed"

    def environment(self, root):
        for name in ("home", "agent", "project", "temp"):
            (root / name).mkdir()
        write_json(root / "agent/settings.json", {"theme": "dark", "packages": [], "retry": {"enabled": False}})
        env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "USERPROFILE": str(root / "home"),
               "XDG_CONFIG_HOME": str(root / "home/config"), "XDG_CACHE_HOME": str(root / "home/cache"),
               "TMPDIR": str(root / "temp"), "DIFFEX_CODING_AGENT_DIR": str(root / "agent"),
               "DIFFEX_NO_LOCAL_LLM": "1", "TERM": "xterm-256color", "LANG": "C.UTF-8",
               "DIFFEX_PROJECT": str(root / "project"), "DIFFEX_BEHAVIOR_RECORD": str(root / "events.jsonl")}
        return env

    def args_for(self, extension, model):
        return ["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "-e", str(extension), "--model", model]

    def process(self, executable, args, env, project, evidence):
        remaining = self.deadline - time.monotonic()
        assert remaining > 0, "Run deadline exceeded"
        result = subprocess.run([executable, *args], cwd=project, env=env, capture_output=True, text=True, timeout=min(40, remaining))
        stdout, stderr = result.stdout, result.stderr
        for secret in self.secrets:
            if secret:
                stdout, stderr = stdout.replace(secret, "[REDACTED]"), stderr.replace(secret, "[REDACTED]")
        (evidence / "stdout.txt").write_text(stdout)
        (evidence / "stderr.txt").write_text(stderr)
        assert result.returncode == 0, f"Exit code {result.returncode}; see stdout/stderr"
        return result.stdout

    def behavior(self, executable, evidence, action):
        with tempfile.TemporaryDirectory(prefix="db-", dir="/tmp") as temporary:
            root = Path(temporary)
            env = self.environment(root)
            # Keep the fixture beside node_modules so its import resolves the installed SDK, never the repository.
            fixture = Path(executable).parent.parent.parent / ("behavior-" + uuid.uuid4().hex + ".mjs")
            shutil.copyfile(HERE / ("live-guard.mjs" if self.args.mode == "live" else "fixture.mjs"), fixture)
            try:
                action(env, root, fixture)
                if self.args.mode == "deterministic":
                    assert not any(e["type"] == "blocked-network" for e in read_events(root / "events.jsonl")), "Unexpected external request"
            finally:
                fixture.unlink(missing_ok=True)
                for source, target in [(root / "events.jsonl", evidence / "events.jsonl"),
                                       (root / "agent/sessions", evidence / "sessions"),
                                       (root / "project", evidence / "project")]:
                    files = source.rglob("*") if source.is_dir() else [source]
                    for file in files:
                        if not file.is_file() or file.is_symlink() or file.name in {"auth.json", ".npmrc", ".netrc", ".env"} or file.name.startswith(".env."):
                            continue
                        destination = target / file.relative_to(source) if source.is_dir() else target
                        text = file.read_text(errors="replace")
                        for secret in self.secrets:
                            if secret:
                                text = text.replace(secret, "[REDACTED]")
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_text(text)
                # Never copy home, auth files, settings, or process environment.
                # Redaction happens BEFORE files become incrementally downloadable.

    def deterministic(self, executable, runtime):
        def run_case(name, fn):
            return self.scenario(runtime + "-" + name, lambda evidence: self.behavior(executable, evidence, lambda env, root, fixture: fn(env, root, fixture, evidence)))

        def installation(env, root, fixture, evidence):
            assert Path(executable).is_file(), "Executable missing"
            resolved = str(Path(executable).resolve())
            write_json(evidence / "resolution.json", {"requested": executable, "resolved": resolved})
            args = self.args_for(fixture, "behavior/fixture")
            for name, command, expected in [("help", ["--help"], "Usage"), ("version", ["--version"], ""), ("models", args + ["--list-models"], "fixture")]:
                command_evidence = evidence / name
                command_evidence.mkdir()
                output = self.process(executable, command, env, root / "project", command_evidence)
                assert expected in output and output.strip(), "Installation command output missing"
                if name == "version":
                    assert re.fullmatch(r"\d+\.\d+\.\d+(?:[-+]\S+)?", output.strip()), "Malformed version output"
        run_case("installation", installation)

        def printed(env, root, fixture, evidence):
            output = self.process(executable, self.args_for(fixture, "behavior/fixture") + ["--no-session", "-p", "BEHAVIOR_PRINT"], env, root / "project", evidence)
            assert "behavior-print-ok" in output
        run_case("print", printed)

        def transport(env, root, fixture, evidence):
            env.update(DIFFEX_BEHAVIOR_TRANSPORT="1", OPENAI_API_KEY="fake")
            output = self.process(executable, self.args_for(fixture, "openai/gpt-4.1-mini") + ["--no-session", "-p", "BEHAVIOR_AUTH"], env, root / "project", evidence)
            assert "behavior-auth-ok" in output
        run_case("builtin-auth-transport", transport)

        def tools(env, root, fixture, evidence):
            project = root / "project"
            (project / "input.txt").write_text("behavior-input-marker\n")
            args = self.args_for(fixture, "behavior/fixture")
            record = root / "events.jsonl"
            terminal = Terminal(executable, args, env, project, evidence, self.deadline)
            try:
                terminal.wait("Ask Diffex")
                terminal.screen("startup-80x24", (80, 24), self.args.update_baselines)
                terminal.screen("startup-120x40", (120, 40), self.args.update_baselines)
                terminal.screen("startup-resize-80x24", (80, 24), self.args.update_baselines)
                before = sum(e["type"] == "settled" for e in read_events(record))
                terminal.send("BEHAVIOR_TOOLS")
                terminal.wait("behavior-tools-ok")
                terminal.settled(record, before)
                assert (project / "output.txt").read_text() == "behavior-edited\n"
                assert (project / "bash-result.txt").read_text() == "behavior-edited\n"
                events = read_events(record)
                assert {"read", "write", "edit", "bash"} <= {e.get("toolName") for e in events if e["type"] == "tool_result"}
                assert any(e["type"] == "tool_result" and e.get("toolName") == "read" and "behavior-input-marker" in json.dumps(e.get("content")) for e in events), "Read did not return fixture contents"
                terminal.send("BEHAVIOR_CANCEL")
                terminal.wait("behavior-cancel-started")
                terminal.command("send-keys", "Escape")
                end = time.monotonic() + 10
                while not any(e["type"] == "abort" for e in read_events(record)) and time.monotonic() < end:
                    terminal.capture()
                    time.sleep(.1)
                assert any(e["type"] == "abort" for e in read_events(record)), "Cancel did not abort provider"
                before = sum(e["type"] == "settled" for e in read_events(record))
                terminal.send("BEHAVIOR_RECOVER")
                terminal.wait("behavior-recovered-ok")
                terminal.settled(record, before)
                terminal.exit()
            finally:
                terminal.close()
            sessions = list((root / "agent/sessions").rglob("*.jsonl"))
            assert len(sessions) == 1, "Expected one persisted conversation"
            output = self.process(executable, args + ["--session", str(sessions[0]), "-p", "BEHAVIOR_RESUME"], env, project, evidence)
            assert "behavior-resumed-ok" in output
            resumed = [e for e in read_events(record) if e["type"] == "context" and e.get("mode") == "BEHAVIOR_RESUME"]
            assert resumed and any(m["role"] == "toolResult" and m.get("toolName") == "read" and "behavior-input-marker" in json.dumps(m.get("content")) for m in resumed[-1]["messages"]), "Resumed conversation lost read contents"
            assert not any(e["type"] == "blocked-network" for e in read_events(record)), "Unexpected external network"
        run_case("terminal-tools-cancel-resume", tools)

        # Retain the existing artifact-acceptance CLI/login coverage unchanged.
        def legacy(evidence):
            spec = importlib.util.spec_from_file_location("artifact_terminal", HERE.parent / "verify-candidate-artifacts.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.verify(evidence, {runtime: executable}, HERE.parent / "fixtures/artifact-handoff.mjs")
        self.scenario(runtime + "-artifact-terminal", legacy)

    def live(self, executable):
        def operation(evidence):
            def action(env, root, fixture):
                assert os.environ.get("OPENAI_API_KEY"), "Missing OPENAI_API_KEY"
                env["OPENAI_API_KEY"] = os.environ["OPENAI_API_KEY"]
                env["DIFFEX_BEHAVIOR_STARTED"] = str(int(time.time() * 1000))
                args = self.args_for(fixture, self.args.model)
                marker = "behavior-live-" + uuid.uuid4().hex
                project = root / "project"
                (project / "input.txt").write_text(marker)
                output = self.process(executable, args + ["--no-session", "-p", "Reply with exactly: " + marker], env, project, evidence)
                assert marker in output, "Live print marker absent"
                terminal = Terminal(executable, args, env, project, evidence, self.deadline)
                try:
                    terminal.wait("Ask Diffex")
                    event_mark = len(read_events(root / "events.jsonl"))
                    terminal.send("input.txt contains a marker with no trailing newline. Use read to read input.txt, then use write to copy its exact contents into output.txt. Do not use bash. Then reply with exactly: completed " + marker)
                    terminal.wait("completed " + marker, seconds=120)
                    terminal.settled(root / "events.jsonl", 1, seconds=20)
                    assert (project / "output.txt").read_text() == marker, "Live output.txt did not contain the exact fixture marker bytes"
                    events = read_events(root / "events.jsonl")
                    assert {"read", "write"} <= {e.get("toolName") for e in events if e["type"] == "tool_result" and not e.get("isError")}
                    assert sum(e["type"] == "request" for e in events) <= 6
                    reply = "".join(e["delta"] for e in events[event_mark:] if e["type"] == "streamed-text")
                    assert "completed " + marker in reply, "Interactive streamed confirmation missing"
                    terminal.exit()
                finally:
                    terminal.close()
            self.behavior(executable, evidence, action)
        self.scenario("npm-live-openai", operation)

    def run(self):
        installations = []
        if self.args.executable:
            executable = self.args.executable.absolute()
            self.hashes["installedExecutableSha256"] = hashlib.sha256(executable.resolve().read_bytes()).hexdigest()
            inventory = executable.parent.parent / "@diffexai/diffex/distribution-files.json"
            if inventory.exists():
                self.hashes["installedInventorySha256"] = hashlib.sha256(inventory.read_bytes()).hexdigest()
            installations.append(("local", str(executable)))
        else:
            def manifest_check(evidence):
                manifest = json.loads((self.args.artifacts / "manifest.json").read_text())
                assert manifest["source"]["commit"] == self.args.commit, "Artifact commit mismatch"
                for record in manifest["packages"]:
                    archive = self.args.artifacts / record["filename"]
                    assert archive.parent == self.args.artifacts, "Invalid artifact path"
                    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
                    assert actual == record["sha256"], "Artifact checksum mismatch"
                    self.hashes[record["filename"]] = actual
                toolchain = {}
                for tool, expected in (("node", "v22.23.2"), ("npm", "11.16.0"), ("bun", "1.3.11"), ("tmux", None), ("rg", None), ("fd", None)):
                    command = [tool, "-V" if tool == "tmux" else "--version"]
                    actual = subprocess.check_output(command, text=True, timeout=10).strip()
                    toolchain[tool] = actual
                    if expected:
                        assert actual == expected, f"Toolchain {tool}: expected {expected}, got {actual}"
                toolchain["python"] = sys.version
                assert sys.version_info >= (3, 11), "Python 3.11+ required"
                write_json(evidence / "toolchain.json", toolchain)
                write_json(evidence / "manifest.json", manifest)
            if not self.scenario("artifact-integrity", manifest_check, "configuration"):
                return False
            for manager in (["npm"] if self.args.mode == "live" else ["npm", "bun"]):
                consumer = Path(tempfile.mkdtemp(prefix="diffex-installed-"))
                def install(evidence):
                    result = subprocess.run(["node", str(HERE / "install.mjs"), str(self.args.artifacts), str(consumer), manager, self.args.commit], capture_output=True, text=True, timeout=600)
                    (evidence / "install.txt").write_text(result.stdout + result.stderr)
                    assert result.returncode == 0, "Artifact installation/integrity failed; see install.txt"
                    shutil.copyfile(consumer / "installation.json", evidence / "installation.json")
                if self.scenario(manager + "-package-integrity", install, "configuration"):
                    installations.append((manager, str(consumer / "node_modules/.bin/diffex")))
                else:
                    shutil.rmtree(consumer)
            # npm and Bun scenarios are sequential in this process/sandbox.
        for runtime, executable in installations:
            try:
                if self.args.mode == "live":
                    self.deadline = time.monotonic() + 180
                    self.live(executable)
                else:
                    self.deterministic(executable, runtime)
            finally:
                if not self.args.executable:
                    shutil.rmtree(Path(executable).parent.parent.parent)
        self.save()
        return bool(self.results) and all(r["outcome"] == "passed" for r in self.results)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--artifacts", type=lambda s: Path(s).resolve())
    source.add_argument("--executable", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=["deterministic", "live"], default="deterministic")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--model", default="openai/gpt-4.1-mini")
    parser.add_argument("--update-baselines", action="store_true", help="Local review only; never passed by CI")
    args = parser.parse_args()
    if not re.fullmatch("[a-f0-9]{40}", args.commit):
        parser.error("--commit must be a full SHA")
    raise SystemExit(0 if Runner(args).run() else 1)


if __name__ == "__main__":
    main()
