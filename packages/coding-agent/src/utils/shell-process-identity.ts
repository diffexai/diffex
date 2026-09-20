import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export const SHELL_EXECUTION_ID_ENV = "DIFFEX_SHELL_EXECUTION_ID";

export interface ShellProcessIdentity {
	readonly pid: number;
	readonly processGroupId: number;
	/** Linux boot ID and start ticks, or macOS ps lstart in UTC and the C locale. */
	readonly startTime: string;
}

/** Read live group members without treating orphaned zombies as running work. */
export function readShellProcessGroup(processGroupId: number): ShellProcessIdentity[] {
	if (process.platform === "linux") {
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		const members: ShellProcessIdentity[] = [];
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			try {
				const stat = readFileSync(`/proc/${name}/stat`, "utf8");
				const fields = stat
					.slice(stat.lastIndexOf(")") + 2)
					.trim()
					.split(/\s+/);
				if (Number(fields[2]) !== processGroupId || fields[0] === "Z") continue;
				members.push({ pid: Number(name), processGroupId, startTime: `${bootId}:${fields[19]}` });
			} catch (error) {
				if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
				throw error;
			}
		}
		return members;
	}
	const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat=,lstart="], {
		encoding: "utf8",
		timeout: 1_000,
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
	});
	if (result.status !== 0) throw new Error("Cannot inspect shell process groups", { cause: result.error });
	return result.stdout.split("\n").flatMap((line) => {
		const [pid, group, state, ...started] = line.trim().split(/\s+/);
		return Number(group) === processGroupId && state && !state.startsWith("Z")
			? [{ pid: Number(pid), processGroupId, startTime: started.join(" ") }]
			: [];
	});
}

/** The launch token prevents a recycled group ID from authorizing a signal. */
export function hasShellExecutionToken(pid: number, executionId: string): boolean {
	try {
		const token = `${SHELL_EXECUTION_ID_ENV}=${executionId}`;
		if (process.platform === "linux") {
			return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(token);
		}
		const result = spawnSync("ps", ["-Eww", "-p", String(pid), "-o", "command="], {
			encoding: "utf8",
			timeout: 1_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		return result.status === 0 && result.stdout.split(/\s+/).includes(token);
	} catch {
		return false;
	}
}
