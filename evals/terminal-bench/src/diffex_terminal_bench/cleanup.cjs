// Linux-only recovery, run as the agent user through an independent Harbor exec.
const { readFileSync, writeFileSync, readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

function identity(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[0] === "Z" ? null : fields[19];
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ESRCH") return null;
		throw error;
	}
}

function signal(pid, start, name) {
	if (!start || identity(pid) !== start) return;
	try { process.kill(pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function cleanup(runDir) {
	// Prevent a delayed launcher from starting after transport cancellation.
	writeFileSync(join(runDir, "stop-requested"), "", { mode: 0o600 });
	const marker = `DIFFEX_TB_RUN_DIR=${runDir}`;
	let launcher;
	if (existsSync(join(runDir, "launcher.json"))) launcher = JSON.parse(readFileSync(join(runDir, "launcher.json"), "utf8"));
	if (launcher) signal(launcher.pid, launcher.start, "SIGTERM");
	const seen = new Map();
	const deadline = Date.now() + 7000;
	let remaining = [];
	do {
		const unreadable = new Map();
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
			try {
				if (!identity(entry)) continue;
				if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(marker)) {
					const start = identity(entry);
					if (start) seen.set(Number(entry), start);
				}
			} catch (error) {
				if (error.code === "EACCES") {
					if (!identity(entry)) continue;
					// Other sandbox users' processes are outside this trial launcher.
					let status;
					try { status = readFileSync(`/proc/${entry}/status`, "utf8"); }
					catch (statusError) { if (statusError.code === "ENOENT") continue; throw statusError; }
					if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== process.getuid()) continue;
					// An exiting process can revoke environ access before becoming
					// a zombie. Retry until it exits or becomes readable; never
					// claim cleanup while a same-user process remains uninspectable.
					const start = identity(entry);
					if (start) unreadable.set(Number(entry), start);
					continue;
				}
				if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
			}
		}
		const force = Date.now() >= deadline - 2000;
		for (const [pid, start] of seen) signal(pid, start, force ? "SIGKILL" : "SIGTERM");
		if (launcher && force) signal(launcher.pid, launcher.start, "SIGKILL");
		remaining = [...seen].filter(([pid, start]) => identity(pid) === start).map(([pid]) => pid);
		remaining.push(...[...unreadable].filter(([pid, start]) => identity(pid) === start).map(([pid]) => pid));
		if (launcher && identity(launcher.pid) === launcher.start) remaining.push(launcher.pid);
		if (remaining.length === 0) break;
		await delay(100);
	} while (Date.now() < deadline);
	const report = { confirmed: remaining.length === 0, remaining_pids: remaining, tracked_processes: seen.size };
	writeFileSync(join(runDir, "cleanup.json"), JSON.stringify(report), { mode: 0o600 });
	if (!report.confirmed) process.exitCode = 1;
}

module.exports = { identity };
if (require.main === module) cleanup(process.argv[2]).catch((error) => {
	writeFileSync(join(process.argv[2], "cleanup.json"), JSON.stringify({ confirmed: false, error: error.code ?? error.name, path: error.path }), { mode: 0o600 });
	process.exitCode = 1;
});
