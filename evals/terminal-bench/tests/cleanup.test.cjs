// Run in a Linux container: node --test /eval/tests/cleanup.test.cjs.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { createServer, connect } = require("node:net");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { identity } = require("../src/diffex_terminal_bench/cleanup.cjs");

if (process.argv[2] === "service") {
	process.on("SIGTERM", () => {});
	const server = createServer((socket) => socket.end(String(process.pid)));
	server.listen(0, "127.0.0.1", () => process.send(server.address().port));
} else {
	test("pre-verifier cleanup preserves a transferred marked service", { skip: process.platform !== "linux" }, async () => {
		const runDir = mkdtempSync(join(tmpdir(), "diffex-cleanup-"));
		mkdirSync(join(runDir, "ownership"));
		const service = spawn(process.execPath, [__filename, "service"], {
			detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
			env: { ...process.env, DIFFEX_TB_RUN_DIR: runDir, DIFFEX_SHELL_EXECUTION_ID: "service" },
		});
		try {
			const [port] = await once(service, "message");
			const start = identity(service.pid);
			const member = { pid: service.pid, processGroupId: service.pid,
				startTime: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}` };
			writeFileSync(join(runDir, "ownership/service.json"), JSON.stringify({
				version: 1, executionId: "service", owner: "environment", state: "background",
				processGroupId: service.pid, supervisorPid: process.pid, members: [member],
			}));
			const before = connect(port, "127.0.0.1");
			assert.equal(String((await once(before, "data"))[0]), String(service.pid));
			before.destroy();
			const cleanup = spawn(process.execPath, [join(__dirname, "../src/diffex_terminal_bench/cleanup.cjs"), runDir], { stdio: "inherit" });
			assert.equal((await once(cleanup, "exit"))[0], 0);
			assert.equal(identity(service.pid), start, "the original service must survive cleanup");
			const verifier = connect(port, "127.0.0.1");
			assert.equal(String((await once(verifier, "data"))[0]), String(service.pid));
			verifier.destroy();
		} finally {
			if (service.exitCode === null && service.signalCode === null) {
				service.kill("SIGKILL");
				await once(service, "exit");
			}
			rmSync(runDir, { recursive: true, force: true });
		}
	});
}
