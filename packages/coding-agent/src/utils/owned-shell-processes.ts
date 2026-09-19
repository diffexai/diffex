import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "./shell.ts";

function isAlive(pid: number): boolean {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

/** A session owns the process groups it launches, including background jobs. */
export class OwnedShellProcesses {
	readonly #pids = new Set<number>();

	track(pid: number): void {
		this.#pids.add(pid);
		trackDetachedChildPid(pid);
	}

	releaseIfExited(pid: number): void {
		if (!isAlive(pid)) {
			this.#pids.delete(pid);
			untrackDetachedChildPid(pid);
		}
	}

	get count(): number {
		for (const pid of this.#pids) this.releaseIfExited(pid);
		return this.#pids.size;
	}

	async terminateAll(): Promise<void> {
		const pids = [...this.#pids];
		for (const pid of pids) killProcessTree(pid);
		const deadline = performance.now() + 5_000;
		for (const pid of pids) {
			while (isAlive(pid)) {
				// Linux PID 1 may leave orphaned zombies unreaped. Zombies are terminated,
				// but kill(0) still sees their process group until the parent reaps them.
				if (process.platform !== "win32") {
					const result = spawnSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", timeout: 1_000 });
					if (
						result.status === 0 &&
						!result.stdout.split("\n").some((line) => {
							const [group, state] = line.trim().split(/\s+/);
							return Number(group) === pid && state && !state.startsWith("Z");
						})
					)
						break;
				}
				if (performance.now() >= deadline) throw new Error(`Shell process group ${pid} did not terminate`);
				await delay(25);
			}
			this.#pids.delete(pid);
			untrackDetachedChildPid(pid);
		}
	}
}
