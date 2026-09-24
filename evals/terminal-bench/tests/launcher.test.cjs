const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("launcher preserves task packages outside exported logs and isolates each run", (t) => {
	const root = mkdtempSync(join(tmpdir(), "diffex-launcher-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const states = [];
	for (let index = 0; index < 2; index++) {
		const logs = join(root, `run-${index}`);
		mkdirSync(logs);
		writeFileSync(join(logs, "requested.json"), JSON.stringify({
			provider: "openai", model: "fixture", thinking: "high", tools: ["bash"],
			credential_env_names: [], background_process_lifetime: "environment",
			user_message_suffix: "\nDo not cheat by using online solutions or hints specific to this task.",
		}));
		const child = new EventEmitter();
		child.pid = 12345;
		const gate = new EventEmitter();
		gate.end = (message) => assert.equal(message, "start\n");
		child.stdio = [null, null, null, gate];
		let childEnv;
		runInNewContext(readFileSync(resolve(__dirname, "../src/diffex_terminal_bench/run.cjs"), "utf8"), {
			require: (name) => {
				if (name === "./cleanup.cjs") return { identity: () => "100" };
				if (name === "node:child_process") return { spawn: (command, args, options) => {
					childEnv = options.env;
					assert.equal(command, "/bin/sh");
					assert.ok(args.includes(join(logs, "ownership")));
					assert.ok(args.includes("--no-context-files"));
					assert.equal(args[args.indexOf("--system-prompt") + 1], join(logs, "eval-system-prompt.txt"));
					assert.equal(args.at(-2), `@${join(logs, "instruction.txt")}`);
					assert.equal(args.at(-1), "\nDo not cheat by using online solutions or hints specific to this task.");
					return child;
				} };
				return require(name);
			},
			process: { argv: ["node", "run.cjs", logs], pid: 12344, cwd: () => root, on: () => {},
				env: { PATH: process.env.PATH, DIFFEX_TB_PROVIDER: "openai", DIFFEX_TB_MODEL: "fixture", DIFFEX_TB_THINKING: "high" } },
			setTimeout, clearTimeout,
		});
		const state = JSON.parse(readFileSync(join(logs, "state.json"), "utf8"));
		t.after(() => rmSync(state.state_dir, { recursive: true, force: true }));
		states.push(state.state_dir);
		assert.equal(childEnv.HOME, state.home);
		assert.equal(childEnv.DIFFEX_CODING_AGENT_DIR, state.state_dir);
		assert.equal(childEnv.DIFFEX_SESSION_DIR, join(logs, "sessions"));
		assert.ok(state.state_dir.startsWith("/tmp/diffex-tb-state-"));
		assert.equal(existsSync(join(logs, "state")), false);
		const cache = join(state.home, ".cache");
		assert.equal(existsSync(cache), false);
		mkdirSync(cache);
		writeFileSync(join(cache, "package"), "task dependency");
		const fixture = join(__dirname, "faux-provider.cjs");
		const prepare = spawnSync(process.execPath, [fixture, "prepare"], { env: childEnv, encoding: "utf8" });
		assert.equal(prepare.status, 0, prepare.stderr);
		assert.equal(JSON.parse(readFileSync(join(logs, "fixture-start.json"), "utf8")).settings.evolution.enabled, false);
		child.emit("close", 0, null);
		assert.equal(readFileSync(join(cache, "package"), "utf8"), "task dependency");
		assert.equal(JSON.parse(readFileSync(join(logs, "process.json"), "utf8")).exit_code, 0);
		const contaminate = spawnSync(process.execPath, [fixture, "contaminate", state.state_dir], { encoding: "utf8" });
		assert.equal(contaminate.status, 0, contaminate.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(state.state_dir, "auth.json"), "utf8")), { stale: true });
	}
	assert.notEqual(states[0], states[1]);
});
