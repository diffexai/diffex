// Run in a Linux container: node --test /eval/tests/cleanup.test.cjs.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { createServer, connect } = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { identity } = require("../src/diffex_terminal_bench/cleanup.cjs");

if (process.argv[2] === "service") {
	process.on("SIGTERM", () => {});
	const server = createServer((socket) => socket.end(String(process.pid)));
	server.listen(0, "127.0.0.1", () => process.send(server.address().port));
} else {
	async function fixture(t) {
		const runDir = mkdtempSync(join(tmpdir(), "diffex-cleanup-"));
		mkdirSync(join(runDir, "ownership"));
		const children = [];
		t.after(async () => {
			for (const child of children) {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					await once(child, "exit");
				}
			}
			rmSync(runDir, { recursive: true, force: true });
		});
		return {
			runDir,
			async service(executionId, marked = true) {
				const child = spawn(process.execPath, [__filename, "service"], {
					detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
					env: { ...process.env, ...(marked ? { DIFFEX_TB_RUN_DIR: runDir } : {}),
						DIFFEX_SHELL_EXECUTION_ID: executionId },
				});
				children.push(child);
				const [port] = await once(child, "message", { signal: t.signal });
				const start = identity(child.pid);
				const member = { pid: child.pid, processGroupId: child.pid,
					startTime: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}` };
				return { child, port, start, member, executionId };
			},
			publish(service, owner = "environment", overrides = {}) {
				const record = { version: 1, executionId: service.executionId, owner,
					state: owner === "environment" ? "background" : "active", processGroupId: service.child.pid,
					supervisorPid: process.pid, members: [service.member], ...overrides };
				writeFileSync(join(runDir, `ownership/${service.executionId}.json`), JSON.stringify(record));
				return record;
			},
			async cleanup(expectedCode = 0) {
				const child = spawn(process.execPath, [join(__dirname, "../src/diffex_terminal_bench/cleanup.cjs"), runDir], { stdio: "inherit" });
				children.push(child);
				assert.equal((await once(child, "exit", { signal: t.signal }))[0], expectedCode);
				return JSON.parse(readFileSync(join(runDir, "cleanup.json"), "utf8"));
			},
		};
	}

	async function verify(service) {
		assert.equal(identity(service.child.pid), service.start, "the original service must survive cleanup");
		const socket = connect(service.port, "127.0.0.1");
		try {
			assert.equal(String((await once(socket, "data"))[0]), String(service.child.pid));
		} finally {
			socket.destroy();
		}
	}

	const options = { skip: process.platform !== "linux", timeout: 15000 };
	test("pre-verifier cleanup preserves a transferred marked service", options, async (t) => {
		const f = await fixture(t);
		const service = await f.service("service");
		f.publish(service);
		await verify(service);
		const report = await f.cleanup();
		assert.equal(report.agent_execution_stopped, true);
		assert.deepEqual(report.remaining_agent_pids, []);
		assert.equal(report.retained_processes[0].pid, service.child.pid);
		await verify(service);
		assert.deepEqual(await f.cleanup(), report, "cleanup is idempotent");
	});

	test("forced CLI death preserves handoffs and kills TERM-resistant unfinished work", options, async (t) => {
		const f = await fixture(t);
		const service = await f.service("service");
		f.publish(service);
		const active = await f.service("active");
		f.publish(active, "session");
		const cli = await f.service("control");
		writeFileSync(join(f.runDir, "cli.json"), JSON.stringify({ pid: cli.child.pid, start: cli.start }));
		cli.child.kill("SIGKILL");
		await once(cli.child, "exit");
		const report = await f.cleanup();
		assert.equal(identity(active.child.pid), null);
		assert.equal(report.control_processes[0].pid, cli.child.pid);
		await verify(service);
	});

	test("cleanup stops TERM-resistant control activity before allowing verification", options, async (t) => {
		const f = await fixture(t);
		const service = await f.service("service");
		f.publish(service);
		const cli = await f.service("control");
		writeFileSync(join(f.runDir, "cli.json"), JSON.stringify({ pid: cli.child.pid, start: cli.start }));
		const report = await f.cleanup();
		assert.equal(report.agent_execution_stopped, true);
		assert.equal(identity(cli.child.pid), null);
		await verify(service);
	});

	test("PID reuse cannot signal an unrelated process or authorize a stale handoff", options, async (t) => {
		const f = await fixture(t);
		const unrelated = await f.service("unrelated", false);
		writeFileSync(join(f.runDir, "launcher.json"), JSON.stringify({ pid: unrelated.child.pid, start: "recycled" }));
		const active = await f.service("active");
		f.publish(active, "environment", { executionId: "stale", members: [{ ...active.member, startTime: "old-boot:0" }] });
		// The filename and token must refer to the stale execution, not the new one.
		const stale = join(f.runDir, "ownership/active.json");
		writeFileSync(join(f.runDir, "ownership/stale.json"), readFileSync(stale));
		rmSync(stale);
		const report = await f.cleanup();
		assert.deepEqual(report.retained_processes, []);
		assert.equal(identity(active.child.pid), null);
		await verify(unrelated);
	});

	test("invalid or contradictory handoff evidence fails closed without killing the service", options, async (t) => {
		const f = await fixture(t);
		const service = await f.service("service");
		f.publish(service, "environment", { state: "active" });
		assert.equal((await f.cleanup(1)).agent_execution_stopped, false);
		await verify(service);
		f.publish(service);
		writeFileSync(join(f.runDir, "ownership/conflict.json"), JSON.stringify({
			...f.publish(service), executionId: "conflict", owner: "session", state: "active",
		}));
		assert.equal((await f.cleanup(1)).agent_execution_stopped, false);
		await verify(service);
	});

	test("stop barrier prevents a delayed real launcher from spawning the CLI", options, async (t) => {
		const f = await fixture(t);
		await f.cleanup();
		const launcher = spawn(process.execPath, [join(__dirname, "../src/diffex_terminal_bench/run.cjs"), f.runDir]);
		assert.equal((await once(launcher, "exit", { signal: t.signal }))[0], 1);
		const report = await f.cleanup();
		assert.equal(report.control_processes[0].role, "launcher");
		assert.equal(report.agent_execution_stopped, true);
	});

	test("launcher death before PID publication cannot release the CLI gate", options, async (t) => {
		const f = await fixture(t);
		writeFileSync(join(f.runDir, "requested.json"), JSON.stringify({ provider: "openai", model: "fixture",
			thinking: "off", tools: ["bash"], credential_env_names: [], background_process_lifetime: "environment" }));
		writeFileSync(join(f.runDir, "release-agents.md"), "Fixture context");
		const launcher = spawn(process.execPath, ["--require", join(__dirname, "fixtures/kill-before-cli-publication.cjs"),
			join(__dirname, "../src/diffex_terminal_bench/run.cjs"), f.runDir], {
			env: { ...process.env, DIFFEX_TB_PROVIDER: "openai", DIFFEX_TB_MODEL: "fixture", DIFFEX_TB_THINKING: "off" },
		});
		assert.equal((await once(launcher, "exit", { signal: t.signal }))[1], "SIGKILL");
		const child = JSON.parse(readFileSync(join(f.runDir, "gated-child.json"), "utf8"));
		// EOF must stop the waiting child even before independent cleanup runs.
		const deadline = Date.now() + 2000;
		while (identity(child.pid) === child.start && Date.now() < deadline) await delay(10);
		assert.notEqual(identity(child.pid), child.start);
		assert.equal((await f.cleanup()).agent_execution_stopped, true);
	});
}
