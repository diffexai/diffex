import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "./shell.ts";
import { hasShellExecutionToken, readShellProcessGroup, type ShellProcessIdentity } from "./shell-process-identity.ts";

export type BackgroundProcessPolicy =
	| { readonly lifetime: "session" }
	| { readonly lifetime: "environment"; readonly ownershipDirectory: string };

export interface ShellOwnershipRecord {
	readonly version: 1;
	readonly executionId: string;
	readonly owner: "session" | "environment";
	readonly state: "active" | "background" | "terminated";
	readonly processGroupId: number;
	readonly supervisorPid: number;
	readonly members: readonly ShellProcessIdentity[];
}

interface Execution {
	readonly id: string;
	state: "active" | "background" | "terminating";
	members: readonly ShellProcessIdentity[];
}

/** Session ownership ends only after a successful, durably published handoff. */
export class OwnedShellProcesses {
	readonly policy: BackgroundProcessPolicy;
	readonly #executions = new Map<number, Execution>();

	constructor(policy: BackgroundProcessPolicy = { lifetime: "session" }) {
		if (policy.lifetime !== "session" && policy.lifetime !== "environment") {
			throw new Error("Invalid background process lifetime");
		}
		if (policy.lifetime === "environment") {
			if (process.platform !== "linux" && process.platform !== "darwin") {
				throw new Error("Environment background process ownership requires Linux or macOS");
			}
			if (!policy.ownershipDirectory || !isAbsolute(policy.ownershipDirectory)) {
				throw new Error("Environment background process ownership requires an absolute ownershipDirectory");
			}
			mkdirSync(policy.ownershipDirectory, { recursive: true, mode: 0o700 });
		}
		this.policy = Object.freeze({ ...policy });
	}

	track(pid: number, executionId: string): void {
		const execution: Execution = { id: executionId, state: "active", members: [] };
		this.#executions.set(pid, execution);
		trackDetachedChildPid(pid, () => this.terminate(pid));
		try {
			execution.members = process.platform === "win32" ? [] : readShellProcessGroup(pid);
			this.#publish(pid, execution, "session", "active");
		} catch (error) {
			this.terminate(pid);
			throw error;
		}
	}

	/** Called synchronously on shell exit, before output draining or another event can cancel it. */
	complete(pid: number, successful: boolean): void {
		const execution = this.#executions.get(pid);
		if (execution?.state !== "active") return;
		// This callback belongs to the ChildProcess just reaped by Node. Capture the
		// surviving group now; later cleanup must validate these process identities.
		execution.members = process.platform === "win32" ? [] : readShellProcessGroup(pid);
		execution.state = "background";
		if (!successful || this.policy.lifetime === "session") return;
		const members = this.#members(pid, execution);
		if (members.length === 0) {
			this.releaseIfExited(pid);
			return;
		}
		execution.members = members;
		// No await between publication and removing both cleanup registrations.
		// Atomic rename is the ownership commit point, including after a forced CLI death.
		this.#publish(pid, execution, "environment", "background");
		this.#executions.delete(pid);
		untrackDetachedChildPid(pid);
	}

	#publish(
		pid: number,
		execution: Execution,
		owner: ShellOwnershipRecord["owner"],
		state: ShellOwnershipRecord["state"],
	): void {
		if (this.policy.lifetime !== "environment") return;
		const record: ShellOwnershipRecord = {
			version: 1,
			executionId: execution.id,
			owner,
			state,
			processGroupId: pid,
			supervisorPid: process.pid,
			members: execution.members,
		};
		const path = join(this.policy.ownershipDirectory, `${execution.id}.json`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		const fd = openSync(temporary, "wx", 0o600);
		try {
			try {
				writeFileSync(fd, `${JSON.stringify(record)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, path);
		} finally {
			try {
				unlinkSync(temporary);
			} catch {}
		}
	}

	#members(pid: number, execution: Execution): ShellProcessIdentity[] {
		const members = readShellProcessGroup(pid);
		if (members.length === 0) return [];
		const known = members.some((member) =>
			execution.members.some((previous) => previous.pid === member.pid && previous.startTime === member.startTime),
		);
		if (!known && !members.some((member) => hasShellExecutionToken(member.pid, execution.id))) {
			throw new Error(`Cannot verify ownership of shell process group ${pid}`);
		}
		return members;
	}

	terminate(pid: number): void {
		const execution = this.#executions.get(pid);
		if (!execution) return;
		if (execution.state === "active" && process.platform !== "win32") {
			// The launching ChildProcess has not delivered its exit event yet.
			execution.members = readShellProcessGroup(pid);
		}
		execution.state = "terminating";
		if (process.platform === "win32") {
			killProcessTree(pid);
		} else if (this.#members(pid, execution).length > 0) {
			// Never fall back to a recycled leader PID when its group has disappeared.
			try {
				process.kill(-pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}

	releaseIfExited(pid: number): void {
		const execution = this.#executions.get(pid);
		if (!execution) return;
		let alive: boolean;
		if (process.platform === "win32") {
			try {
				process.kill(pid, 0);
				alive = true;
			} catch {
				alive = false;
			}
		} else {
			alive = this.#members(pid, execution).length > 0;
		}
		if (!alive) {
			this.#publish(pid, execution, "session", "terminated");
			this.#executions.delete(pid);
			untrackDetachedChildPid(pid);
		}
	}

	get count(): number {
		for (const pid of this.#executions.keys()) this.releaseIfExited(pid);
		return this.#executions.size;
	}

	async terminateAll(): Promise<void> {
		const pids = [...this.#executions.keys()];
		for (const pid of pids) this.terminate(pid);
		const deadline = performance.now() + 5_000;
		for (const pid of pids) {
			while (this.#executions.has(pid)) {
				this.releaseIfExited(pid);
				if (!this.#executions.has(pid)) break;
				if (performance.now() >= deadline) throw new Error(`Shell process group ${pid} did not terminate`);
				await delay(25);
			}
		}
	}
}
