// Launch the installed CLI with only the explicitly selected environment.
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { identity } = require("./cleanup.cjs");

const runDir = process.argv[2];
writeFileSync(join(runDir, "launcher.json"), JSON.stringify({ pid: process.pid, start: identity(process.pid) }), { mode: 0o600 });
if (existsSync(join(runDir, "stop-requested"))) process.exit(1);
const config = JSON.parse(readFileSync(join(runDir, "requested.json"), "utf8"));
if (process.env.DIFFEX_TB_PROVIDER !== config.provider || process.env.DIFFEX_TB_MODEL !== config.model ||
	process.env.DIFFEX_TB_THINKING !== config.thinking) throw new Error("Harbor environment differs from requested.json");
// Keep packages, caches, credentials, and mutable harness state on sandbox
// disk. Preserve them through verification for retained task services.
const state = mkdtempSync("/tmp/diffex-tb-state-");
writeFileSync(join(runDir, "state.json"), JSON.stringify({ state_dir: state, home: join(state, "home") }), { mode: 0o600 });
mkdirSync(join(state, "home"), { mode: 0o700 });
mkdirSync(join(runDir, "sessions"), { mode: 0o700 });
writeFileSync(join(state, "settings.json"), JSON.stringify({ evolution: { enabled: false } }), { mode: 0o600 });
const env = {
	PATH: process.env.PATH,
	HOME: join(state, "home"),
	LANG: "C.UTF-8",
	DIFFEX_CODING_AGENT_DIR: state,
	DIFFEX_SESSION_DIR: join(runDir, "sessions"),
	DIFFEX_OFFLINE: "1",
	DIFFEX_TB_RUN_DIR: runDir,
};
for (const name of config.credential_env_names) env[name] = process.env[name];
const args = [
	"--mode", "json", "--provider", process.env.DIFFEX_TB_PROVIDER, "--model", process.env.DIFFEX_TB_MODEL,
	"--thinking", process.env.DIFFEX_TB_THINKING, "--tools", config.tools.join(","),
	"--session", join(runDir, "sessions", "root.jsonl"),
	"--session-dir", join(runDir, "sessions"),
	"--background-process-lifetime", config.background_process_lifetime,
	"--background-process-ownership-dir", join(runDir, "ownership"),
	"--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
	"--no-context-files", "--system-prompt", join(runDir, "eval-system-prompt.txt"),
	"--extension", join(runDir, "observe.mjs"), "--print", `@${join(runDir, "instruction.txt")}`,
	config.user_message_suffix,
];
const stdout = openSync(join(runDir, "stdout.jsonl"), "wx", 0o600);
const stderr = openSync(join(runDir, "stderr.log"), "wx", 0o600);
// Even an uncatchable launcher kill leaves explicit unknown process status.
writeFileSync(join(runDir, "process.json"), JSON.stringify({
	exit_code: null, signal: null, spawn_error: null, interrupted: false,
}), { mode: 0o600 });
// The child cannot execute the CLI before its identity is durable. If the
// launcher dies during publication, EOF on the private pipe closes the gate.
// exec preserves this PID and start time through the installed CLI wrapper.
const child = spawn("/bin/sh", ["-c",
	'read -r ready <&3 && [ "$ready" = start ] || exit 1; exec 3<&-; exec /usr/local/bin/diffex "$@"',
	"diffex", ...args], {
	cwd: process.cwd(), env, stdio: ["ignore", stdout, stderr, "pipe"], detached: true,
});
const childStart = child.pid ? identity(child.pid) : null;
if (child.pid) writeFileSync(join(runDir, "cli.json"), JSON.stringify({ pid: child.pid, start: childStart }), { mode: 0o600 });
closeSync(stdout);
closeSync(stderr);
let spawnError = null;
let interrupted = false;
let killTimer;
function stop() {
	if (interrupted) return;
	interrupted = true;
	if (!child.pid) return;
	// Signal only the identified CLI. Group signals could reach retained task
	// services; independent recovery handles active descendants after CLI exit.
	if (identity(child.pid) === childStart) {
		try { process.kill(child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
	}
	killTimer = setTimeout(() => {
		if (identity(child.pid) === childStart) {
			try { process.kill(child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
		}
	}, 5000);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
child.on("error", (error) => { spawnError = error.code ?? error.name; });
child.stdio[3].on("error", (error) => { spawnError = error.code ?? error.name; });
child.on("close", (code, signal) => {
	clearTimeout(killTimer);
	writeFileSync(join(runDir, "process.json"), JSON.stringify({
		exit_code: code, signal, spawn_error: spawnError, interrupted,
	}), { mode: 0o600 });
	process.exitCode = interrupted ? 1 : (code ?? 1);
});
// Close the race with a stop request written during synchronous initialization.
if (existsSync(join(runDir, "stop-requested"))) {
	child.stdio[3].end();
	stop();
} else {
	child.stdio[3].end("start\n");
}
