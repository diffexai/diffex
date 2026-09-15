// Launch the installed CLI with only the explicitly selected environment.
const { spawnSync } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } = require("node:fs");
const { join } = require("node:path");

const runDir = process.argv[2];
const config = JSON.parse(readFileSync(join(runDir, "requested.json"), "utf8"));
const state = join(runDir, "state");
// No recursive creation: reusing any prior state is an error.
mkdirSync(state, { mode: 0o700 });
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
	"--mode", "json", "--provider", config.provider, "--model", config.model,
	"--thinking", config.thinking, "--tools", config.tools.join(","),
	"--session", join(runDir, "sessions", "root.jsonl"),
	"--session-dir", join(runDir, "sessions"),
	"--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
	"--extension", join(runDir, "observe.mjs"), "--print", "DIFFEX_TERMINAL_BENCH_INSTRUCTION",
];
const stdout = openSync(join(runDir, "stdout.jsonl"), "wx", 0o600);
const stderr = openSync(join(runDir, "stderr.log"), "wx", 0o600);
const result = spawnSync("/usr/local/bin/diffex", args, {
	cwd: process.cwd(), env, stdio: ["ignore", stdout, stderr],
});
closeSync(stdout);
closeSync(stderr);
writeFileSync(join(runDir, "process.json"), JSON.stringify({
	exit_code: result.status, signal: result.signal, spawn_error: result.error?.code ?? null,
}));
if (result.status !== 0) process.exit(result.status ?? 1);
// Fuzzy model resolution and unsupported thinking levels must not silently
// change a benchmark configuration. The observer records actual CLI state.
const effective = JSON.parse(readFileSync(join(runDir, "effective.json"), "utf8"));
if (effective.provider !== config.provider || effective.model !== config.model ||
	effective.thinking !== config.thinking || !effective.release_agents_loaded ||
	!effective.instruction_delivered || effective.instruction_sha256 !== config.instruction_sha256 ||
	effective.tools.slice().sort().join(",") !== config.tools.slice().sort().join(",")) {
	throw new Error("Effective Diffex configuration differs from requested.json");
}
