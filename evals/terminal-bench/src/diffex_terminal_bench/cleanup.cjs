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

function snapshot() {
	const processes = new Map();
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			if (fields[0] === "Z") continue;
			const uid = Number(readFileSync(`/proc/${entry}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1]);
			let env;
			try { env = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0"); }
			catch (error) {
				if (error.code !== "EACCES") throw error;
				if (uid !== process.getuid()) continue;
			}
			processes.set(Number(entry), { pid: Number(entry), start: fields[19], group: Number(fields[2]), env });
		} catch (error) {
			if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
		}
	}
	return processes;
}

function ownership(runDir) {
	const directory = join(runDir, "ownership");
	if (!existsSync(directory)) return [];
	return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => {
		const record = JSON.parse(readFileSync(join(directory, name), "utf8"));
		if (record.version !== 1 || typeof record.executionId !== "string" || !record.executionId ||
			name !== `${record.executionId}.json` ||
			!Number.isSafeInteger(record.processGroupId) || record.processGroupId <= 1 ||
			!Number.isSafeInteger(record.supervisorPid) || record.supervisorPid <= 1 ||
			!((record.owner === "environment" && record.state === "background") ||
				(record.owner === "session" && ["active", "terminated"].includes(record.state))) ||
			!Array.isArray(record.members) || (record.owner === "environment" && !record.members.length) ||
			record.members.some((member) => !Number.isSafeInteger(member.pid) || member.pid <= 1 ||
				member.processGroupId !== record.processGroupId || typeof member.startTime !== "string" || !member.startTime)) {
			throw new Error("Invalid shell ownership record");
		}
		return record;
	});
}

async function cleanup(runDir) {
	// This barrier must precede discovery, including when the launcher has not started.
	writeFileSync(join(runDir, "stop-requested"), "", { mode: 0o600 });
	const controls = new Map();
	const deadline = Date.now() + 7000;
	const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	const seen = new Map();
	let remaining = [];
	let retained = [];
	let records = [];
	let stopped = false;
	let quietScans = 0;
	do {
		// Re-read identities to close delayed spawn/publication races. Do not
		// inspect handoffs until their writers have stopped publishing them.
		for (const name of ["launcher", "cli"]) {
			const path = join(runDir, `${name}.json`);
			if (!existsSync(path)) continue;
			const control = JSON.parse(readFileSync(path, "utf8"));
			if (Object.keys(control).sort().join(",") !== "pid,start" || !Number.isSafeInteger(control.pid) || control.pid <= 1 ||
				typeof control.start !== "string" || !control.start) throw new Error("Invalid control identity");
			controls.set(name, control);
		}
		// Leave time for TERM-resistant active descendants after control shutdown.
		const force = Date.now() >= deadline - 4000;
		for (const control of controls.values()) signal(control.pid, control.start, force ? "SIGKILL" : "SIGTERM");
		remaining = [...controls.values()].filter((control) => identity(control.pid) === control.start).map((control) => control.pid);
		if (!remaining.length) {
			stopped = true;
			records = ownership(runDir);
			const processes = snapshot();
			const owned = new Map();
			for (const record of records) {
				const members = [...processes.values()].filter((member) => member.group === record.processGroupId);
				const known = members.some((member) => record.members.some((previous) =>
					previous.pid === member.pid && previous.startTime === `${boot}:${member.start}`) ||
					member.env?.includes(`DIFFEX_SHELL_EXECUTION_ID=${record.executionId}`));
				if (!known) continue; // A recycled group ID is not ownership evidence.
				for (const member of members) {
					if (owned.has(member.pid) && owned.get(member.pid).executionId !== record.executionId) {
						throw new Error("Conflicting shell ownership records");
					}
					if ([...controls.values()].some((control) => control.pid === member.pid && control.start === member.start)) {
						throw new Error("Control process claimed by shell ownership");
					}
					owned.set(member.pid, record);
				}
			}
			retained = [];
			for (const member of processes.values()) {
				const record = owned.get(member.pid);
				if (record?.owner === "environment") {
					retained.push({ pid: member.pid, startTime: `${boot}:${member.start}`,
						processGroupId: member.group, executionId: record.executionId, owner: "environment" });
				} else if (record || member.env?.includes(`DIFFEX_TB_RUN_DIR=${runDir}`)) {
					seen.set(member.pid, member.start);
				} else if (!member.env) {
					remaining.push(member.pid); // Never claim success with uninspectable same-user work.
				}
			}
			for (const [pid, start] of seen) signal(pid, start, Date.now() >= deadline - 2000 ? "SIGKILL" : "SIGTERM");
			remaining.push(...[...seen].filter(([pid, start]) => identity(pid) === start).map(([pid]) => pid));
			// A parent can fork after /proc enumeration and before its signal.
			// Scan again after all discovered active work has exited.
			quietScans = remaining.length ? 0 : quietScans + 1;
			if (quietScans >= 2) break;
		}
		await delay(100);
	} while (Date.now() < deadline);
	const report = {
		schema_version: 1, phase: "pre-verifier", stop_requested: true,
		agent_execution_stopped: stopped && remaining.length === 0 && quietScans >= 2,
		ownership_validated: stopped, remaining_agent_pids: [...new Set(remaining)],
		control_processes: [...controls].map(([role, control]) => ({ role, ...control })),
		retained_processes: retained, ownership_records: records,
	};
	writeFileSync(join(runDir, "cleanup.json"), JSON.stringify(report), { mode: 0o600 });
	if (!report.agent_execution_stopped) process.exitCode = 1;
}

module.exports = { identity };
if (require.main === module) cleanup(process.argv[2]).catch((error) => {
	writeFileSync(join(process.argv[2], "cleanup.json"), JSON.stringify({ schema_version: 1, phase: "pre-verifier", agent_execution_stopped: false, ownership_validated: false, error: error.code ?? error.name, path: error.path }), { mode: 0o600 });
	process.exitCode = 1;
});
