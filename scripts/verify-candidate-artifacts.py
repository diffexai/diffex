import os, sys, json, subprocess, tempfile, shutil, pathlib, pty, select, time, re, fcntl, termios, struct

if len(sys.argv) not in (2, 3):
    raise SystemExit(
        "Usage: python3 scripts/verify-candidate-artifacts.py ARTIFACT_DIRECTORY"
    )
out = pathlib.Path(sys.argv[1]).resolve()
fixture_source = (
    pathlib.Path(__file__).resolve().parent / "fixtures/artifact-handoff.mjs"
)
executables = {
    "node": str(out / "node/node_modules/.bin/diffex"),
    "bun-install": str(out / "bun-install/node_modules/.bin/diffex"),
}
if len(sys.argv) == 3:
    executables = {"consumer": str(pathlib.Path(sys.argv[2]).resolve() / "node_modules/.bin/diffex")}
results = []
for runtime, exe in executables.items():
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
        fixture_fd, fixture_path = tempfile.mkstemp(prefix="artifact-fixture-", suffix=".mjs", dir=pathlib.Path(exe).parent.parent.parent)
        os.close(fixture_fd)
        fixture = pathlib.Path(fixture_path)
        shutil.copyfile(fixture_source, fixture)
        args = [
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
                [exe] + command,
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
            os.execve(exe, args, env)
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
            (out / f"{runtime}-terminal.txt").write_text(text)
            assert stage == "exit", (stage, text[-4000:])
            ended, status = os.waitpid(pid, os.WNOHANG)
            reap_deadline = time.monotonic() + 2
            while not ended and time.monotonic() < reap_deadline:
                time.sleep(0.02)
                ended, status = os.waitpid(pid, os.WNOHANG)
            assert ended == pid, "Terminal did not exit within its bounded deadline"
            pid = None
            assert os.waitstatus_to_exitcode(status) == 0
            (out / f"{runtime}-terminal.txt").write_text(text)
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
(out / "smoke.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results, indent=2))
