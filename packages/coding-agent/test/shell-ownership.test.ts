import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { OwnedShellProcesses, type ShellOwnershipRecord } from "../src/utils/owned-shell-processes.ts";
import { killTrackedDetachedChildren } from "../src/utils/shell.ts";
import * as identity from "../src/utils/shell-process-identity.ts";

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("shell ownership handoff", () => {
	it.each(["session", "environment"] as const)("keeps %s cleanup semantics", async (lifetime) => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-shell-ownership-"));
		const owner = new OwnedShellProcesses(
			lifetime === "session" ? { lifetime } : { lifetime, ownershipDirectory: directory },
		);
		let pid: number | undefined;
		try {
			await createLocalBashOperations({ owner }).exec(
				"echo $$ > group.pid; sleep 60 >/dev/null 2>&1 & echo $! > child.pid",
				directory,
				{
					onData() {},
				},
			);
			pid = Number(readFileSync(join(directory, "child.pid"), "utf8"));
			expect(owner.count).toBe(lifetime === "environment" ? 0 : 1);
			if (lifetime === "environment") {
				const records = readdirSync(directory).filter((path) => path.endsWith(".json"));
				expect(records).toHaveLength(1);
				const record: ShellOwnershipRecord = JSON.parse(readFileSync(join(directory, records[0]), "utf8"));
				expect(record).toMatchObject({ version: 1, owner: "environment", state: "background" });
				expect(record.members.some((member) => member.pid === pid && member.startTime.length > 0)).toBe(true);
			}
			killTrackedDetachedChildren();
			await owner.terminateAll();
			await owner.terminateAll();
			if (lifetime === "environment") expect(() => process.kill(pid!, 0)).not.toThrow();
			else {
				const group = Number(readFileSync(join(directory, "group.pid"), "utf8"));
				await vi.waitFor(() => expect(identity.readShellProcessGroup(group)).toHaveLength(0));
			}
		} finally {
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			await owner.terminateAll();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["failure", "timeout", "abort"])("retains ownership after %s", async (scenario) => {
		const directory = mkdtempSync(join(tmpdir(), "diffex-shell-cancel-"));
		const owner = new OwnedShellProcesses({ lifetime: "environment", ownershipDirectory: directory });
		const controller = new AbortController();
		let pid: number | undefined;
		try {
			const result = createLocalBashOperations({ owner }).exec(
				`sleep 60 >/dev/null 2>&1 & echo $! > child.pid; echo ready; ${scenario === "failure" ? "exit 1" : "wait"}`,
				directory,
				{
					onData() {
						if (scenario === "abort") controller.abort();
					},
					signal: controller.signal,
					timeout: scenario === "timeout" ? 0.2 : undefined,
				},
			);
			if (scenario === "failure") expect((await result).exitCode).toBe(1);
			else await expect(result).rejects.toThrow(scenario === "abort" ? "aborted" : "timeout");
			pid = Number(readFileSync(join(directory, "child.pid"), "utf8"));
			const records = readdirSync(directory).filter((path) => path.endsWith(".json"));
			expect(records).toHaveLength(1);
			expect(JSON.parse(readFileSync(join(directory, records[0]), "utf8")).owner).toBe("session");
			await owner.terminateAll();
			expect(owner.count).toBe(0);
		} finally {
			controller.abort();
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			await owner.terminateAll();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["cancellation-first", "handoff-first", "publication-failure"])(
		"retains exactly one owner when %s",
		async (scenario) => {
			const directory = mkdtempSync(join(tmpdir(), "diffex-shell-race-"));
			const owner = new OwnedShellProcesses({ lifetime: "environment", ownershipDirectory: directory });
			const executionId = randomUUID();
			const path = join(directory, `${executionId}.json`);
			const pid = 123457;
			const read = vi
				.spyOn(identity, "readShellProcessGroup")
				.mockReturnValue([{ pid, processGroupId: pid, startTime: "original" }]);
			const kill = vi.spyOn(process, "kill").mockReturnValue(true);
			try {
				owner.track(pid, executionId);
				if (scenario === "cancellation-first") owner.terminate(pid);
				if (scenario === "publication-failure") {
					rmSync(path);
					mkdirSync(path);
					expect(() => owner.complete(pid, true)).toThrow();
					expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
					rmSync(path, { recursive: true });
				} else {
					owner.complete(pid, true);
					owner.complete(pid, true);
					expect(JSON.parse(readFileSync(path, "utf8")).owner).toBe(
						scenario === "handoff-first" ? "environment" : "session",
					);
				}
				owner.terminate(pid);
				killTrackedDetachedChildren();
				if (scenario === "handoff-first") {
					expect(owner.count).toBe(0);
					expect(kill).not.toHaveBeenCalled();
				} else {
					expect(owner.count).toBe(1);
					expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
				}
			} finally {
				read.mockReturnValue([]);
				await owner.terminateAll();
				read.mockRestore();
				kill.mockRestore();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("refuses to signal a recycled process group", async () => {
		const owner = new OwnedShellProcesses();
		const read = vi
			.spyOn(identity, "readShellProcessGroup")
			.mockReturnValue([{ pid: 123456, processGroupId: 123456, startTime: "old" }]);
		const token = vi.spyOn(identity, "hasShellExecutionToken").mockReturnValue(false);
		const kill = vi.spyOn(process, "kill");
		try {
			owner.track(123456, randomUUID());
			owner.complete(123456, true);
			read.mockReturnValue([{ pid: 123456, processGroupId: 123456, startTime: "new" }]);
			expect(() => owner.terminate(123456)).toThrow("Cannot verify ownership");
			expect(kill).not.toHaveBeenCalled();
		} finally {
			read.mockReturnValue([]);
			await owner.terminateAll();
			read.mockRestore();
			token.mockRestore();
			kill.mockRestore();
		}
	});
});
