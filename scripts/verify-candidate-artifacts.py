import os, sys, json, subprocess, tempfile, shutil, pathlib, pty, select, time, re, fcntl, termios, struct
import pwd
import stat


def system_temp_roots():
    """Retain the OS-owned user-temp boundary when isolation overrides TMPDIR."""
    roots = [tempfile.gettempdir(), "/tmp"]
    if sys.platform == "darwin":
        # Darwin's _CS_DARWIN_USER_TEMP_DIR from <unistd.h>. Python does not
        # expose its symbolic name, but confstr accepts the native constant.
        native = os.confstr(65537)
        if not native:
            raise ValueError("missing OS user temporary directory")
        metadata = os.stat(os.path.realpath(native))
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or
                stat.S_IMODE(metadata.st_mode) & 0o077):
            raise ValueError("OS user temporary directory is not owner-private")
        roots.append(native)
    return roots


def local_path(value):
    """Validate a local artifact/evidence path before any filesystem access."""
    value = pathlib.Path(value)
    if ".." in value.parts:
        raise ValueError("path traversal is not permitted")
    roots = {os.path.abspath(root) for root in
             (os.getcwd(), pwd.getpwuid(os.getuid()).pw_dir, *system_temp_roots())}
    roots.discard(os.path.sep)
    roots.update(os.path.realpath(root) for root in tuple(roots))
    absolute = os.path.abspath(value)
    if not absolute.startswith(tuple(root + os.path.sep for root in roots)):
        raise ValueError("path outside local artifact roots")
    scopes = [root for root in roots if os.path.commonpath([root, absolute]) == root and absolute != root]
    scope = max(scopes, key=len)
    canonical = os.path.realpath(absolute)
    canonical_scope = os.path.realpath(scope)
    if not canonical.startswith(canonical_scope + os.path.sep):
        raise ValueError("path outside local artifact root")
    if (os.path.commonpath([canonical_scope, canonical]) != canonical_scope or
            canonical != os.path.join(canonical_scope, os.path.relpath(absolute, scope))):
        raise ValueError("local artifact path traverses a symlink")
    return pathlib.Path(canonical)


def installed_executable(value):
    """Validate the operator-selected npm/Bun consumer before executing its bin.

    Consumers may be anywhere, independently of local evidence output roots.
    Their intentional .bin symlink must resolve to the declared Diffex package
    entrypoint, with no package/directory links redirecting code or fixture I/O.
    """
    value = pathlib.Path(value)
    if ".." in value.parts or value.parts[-3:] != ("node_modules", ".bin", "diffex"):
        raise ValueError("expected an installed Diffex executable")
    absolute = os.path.abspath(value)
    requested_consumer = os.path.dirname(os.path.dirname(os.path.dirname(absolute)))
    consumer = os.path.realpath(requested_consumer)
    # Permit OS-provided temp aliases, not an operator-created consumer link.
    aliases = {os.path.abspath(root) for root in system_temp_roots()}
    alias_match = any(requested_consumer.startswith(root + os.path.sep) and
                      consumer == os.path.join(os.path.realpath(root), os.path.relpath(requested_consumer, root))
                      for root in aliases)
    if requested_consumer != consumer and not alias_match:
        raise ValueError("consumer path traverses a symlink")
    resolved = os.path.realpath(absolute)
    if not resolved.startswith(consumer + os.path.sep):
        raise ValueError("executable escapes its installed consumer")
    if os.path.commonpath([consumer, resolved]) != consumer:
        raise ValueError("executable escapes its installed consumer")
    package = pathlib.Path(consumer) / "node_modules/@diffexai/diffex"
    expected = package / "dist/cli.js"
    if resolved != str(expected) or os.path.realpath(package) != str(package):
        raise ValueError("unexpected installed executable target")
    package = pathlib.Path(resolved).parent.parent
    metadata_path = package / "package.json"
    descriptor = os.open(metadata_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor) as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("invalid installed package metadata")
        metadata = json.load(stream)
    if metadata.get("name") != "@diffexai/diffex" or metadata.get("bin") != {"diffex": "dist/cli.js"}:
        raise ValueError("installed package executable identity mismatch")
    if not pathlib.Path(resolved).is_file() or not os.access(resolved, os.X_OK):
        raise ValueError("installed executable is not executable")
    return resolved, pathlib.Path(resolved).parents[4]


def write_evidence(out, name, text):
    """Replace evidence atomically, never truncate a linked destination."""
    destination = local_path(out / name)
    descriptor, filename = tempfile.mkstemp(prefix=".artifact-evidence-", dir=out)
    temporary = pathlib.Path(filename)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def verify(out, executables, fixture_source=None):
    out = local_path(out)
    validated = {}
    for runtime, executable in executables.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]*", runtime):
            raise ValueError("invalid runtime evidence name")
        validated[runtime] = installed_executable(executable)
    node = shutil.which("node")
    if node is None:
        raise ValueError("Node interpreter is required")
    out.mkdir(parents=True, exist_ok=True)
    fixture_source = fixture_source or pathlib.Path(__file__).resolve().parent / "fixtures/artifact-handoff.mjs"
    results = []
    for runtime, (exe, consumer) in validated.items():
        root = pathlib.Path(tempfile.mkdtemp(prefix="diffex artifact terminal "))
        fixture = None
        try:
            for d in ["home", "agent", "project"]:
                (root / d).mkdir()
            env = {
                "PATH": os.environ["PATH"],
                "HOME": str(root / "home"),
                "USERPROFILE": str(root / "home"),
                "XDG_CONFIG_HOME": str(root / "home/config"),
                "XDG_CACHE_HOME": str(root / "home/cache"),
                "TMPDIR": str(root),
                "DIFFEX_CODING_AGENT_DIR": str(root / "agent"),
                "DIFFEX_NO_LOCAL_LLM": "1",
                "TERM": "xterm-256color",
                "LANG": "en_US.UTF-8",
                "DIFFEX_HANDOFF_RECORD": str(root / "events.jsonl"),
            }
            (root / "agent/settings.json").write_text(
                json.dumps({"theme": "dark", "packages": []})
            )
            (root / "events.jsonl").write_text("")
            fixture_fd, fixture_path = tempfile.mkstemp(prefix="artifact-fixture-", suffix=".mjs", dir=consumer)
            os.close(fixture_fd)
            fixture = pathlib.Path(fixture_path)
            shutil.copyfile(fixture_source, fixture)
            args = [
                node,
                exe,
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-context-files",
                "--no-prompt-templates",
                "-e",
                str(fixture),
                "--model",
                "handoff/fixture",
            ]
            for command in [["--version"], ["--help"], ["auth", "--help"]]:
                p = subprocess.run(
                    [node, exe] + command,
                    cwd=root / "project",
                    env={**env, "DIFFEX_OFFLINE": "1"},
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                assert p.returncode == 0, p.stderr
                results.append(
                    {"runtime": runtime, "command": command, "exitCode": p.returncode}
                )
            for command, expected in [
                (["--list-models"], "fixture"),
                (["-p", "Reply with the fixture confirmation."], "handoff-fixture-ok"),
            ]:
                p = subprocess.run(
                    args + command,
                    cwd=root / "project",
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                assert p.returncode == 0, (p.stdout, p.stderr)
                assert expected in p.stdout, (p.stdout, p.stderr)
                results.append(
                    {
                        "runtime": runtime,
                        "command": command,
                        "exitCode": p.returncode,
                        "expected": expected,
                    }
                )
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(root / "project")
                fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
                os.execve(node, args, env)
            raw = b""
            text = ""
            stage = "startup"
            deadline = time.monotonic() + 30
            mark = 0
            try:
                while time.monotonic() < deadline:
                    if not select.select([fd], [], [], 0.1)[0]:
                        continue
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    raw += chunk
                    text = re.sub(
                        r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw.decode(errors="replace")
                    )
                    if stage == "startup" and "Diffex v" in text:
                        os.write(fd, b"Reply with the fixture confirmation.\r")
                        stage = "reply"
                    elif stage == "reply" and "handoff-fixture-ok" in text:
                        os.write(fd, b"/login\r")
                        stage = "login"
                    elif stage == "login" and "Select authentication method:" in text:
                        os.write(fd, b"\r")
                        stage = "accounts"
                    elif stage == "accounts" and all(
                        name in text for name in ["ChatGPT", "OpenRouter", "xAI"]
                    ):
                        assert not re.search(r"\bRadius\b", text), text
                        mark = len(raw)
                        os.write(fd, b"radius")
                        stage = "account-search"
                    elif stage == "account-search" and b"No matching providers" in raw[mark:]:
                        mark = len(raw)
                        os.write(fd, b"\x03")
                        stage = "back"
                    elif stage == "back" and b"Select authentication method:" in raw[mark:]:
                        mark = len(raw)
                        os.write(fd, b"\x1b[B\r")
                        stage = "api-keys"
                    elif stage == "api-keys" and b"Select provider to configure:" in raw[mark:]:
                        mark = len(raw)
                        os.write(fd, b"radius")
                        stage = "api-key-search"
                    elif stage == "api-key-search" and b"No matching providers" in raw[mark:]:
                        mark = len(raw)
                        os.write(fd, b"\x03")
                        stage = "api-key-back"
                    elif stage == "api-key-back" and b"Select authentication method:" in raw[mark:]:
                        mark = len(raw)
                        os.write(fd, b"\x03")
                        stage = "editor"
                    elif stage == "editor" and b"Ask Diffex" in raw[mark:]:
                        os.write(fd, b"/exit\r")
                        stage = "exit"
                write_evidence(out, f"{runtime}-terminal.txt", text)
                assert stage == "exit", (stage, text[-4000:])
                ended, status = os.waitpid(pid, os.WNOHANG)
                reap_deadline = time.monotonic() + 2
                while not ended and time.monotonic() < reap_deadline:
                    time.sleep(0.02)
                    ended, status = os.waitpid(pid, os.WNOHANG)
                assert ended == pid, "Terminal did not exit within its bounded deadline"
                pid = None
                assert os.waitstatus_to_exitcode(status) == 0
                write_evidence(out, f"{runtime}-terminal.txt", text)
                events = [
                    json.loads(l) for l in (root / "events.jsonl").read_text().splitlines()
                ]
                assert not any(e["type"] == "blocked-network" for e in events), events
                assert sum(e["type"] == "inference" for e in events) == 2, events
                requests = [e["url"] for e in events if e["type"] == "request"]
                assert requests and set(requests) == {
                    "https://api.diffex.ai/api/latest-version"
                }, events
                results.append(
                    {
                        "runtime": runtime,
                        "command": "interactive prompt, subscription and API-key Radius exclusion, exit",
                        "exitCode": 0,
                        "events": events,
                        "accounts": ["ChatGPT", "OpenRouter", "xAI"],
                        "cleanup": "process exited and isolated directories removed",
                    }
                )
            finally:
                os.close(fd)
                if pid:
                    try:
                        os.kill(pid, 9)
                    except ProcessLookupError:
                        pass
                    os.waitpid(pid, 0)
        finally:
            if fixture is not None:
                fixture.unlink(missing_ok=True)
            shutil.rmtree(root)
            assert not root.exists()
    write_evidence(out, "smoke.json", json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))
    return results

if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        raise SystemExit(
            "Usage: python3 scripts/verify-candidate-artifacts.py ARTIFACT_DIRECTORY"
        )
    out = local_path(sys.argv[1])
    fixture_source = (
        pathlib.Path(__file__).resolve().parent / "fixtures/artifact-handoff.mjs"
    )
    executables = {
        "node": str(out / "node/node_modules/.bin/diffex"),
        "bun-install": str(out / "bun-install/node_modules/.bin/diffex"),
    }
    if len(sys.argv) == 3:
        executables = {"consumer": str(pathlib.Path(sys.argv[2]) / "node_modules/.bin/diffex")}
    verify(out, executables, fixture_source)
