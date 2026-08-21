import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvolutionFailureRecord } from "#evolution";
import { FileEvolutionFailureReporter } from "../src/core/evolution-failure-reporter.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function failure(jobId: string, attempt: number): EvolutionFailureRecord {
	return {
		schemaVersion: 1,
		jobId,
		trigger: "manual",
		stage: "reflecting",
		outcome: "terminal-failed",
		reasonCode: "reflection-invalid-response",
		failedAt: `2026-08-20T22:39:2${attempt}.000Z`,
		attempt,
		error: {
			name: "EvolutionExecutionError",
			message: "Reflector returned an invalid response",
			stack: "stack",
			cause: { name: "Error", message: "lessons must be an array", stack: null },
			diagnostics: {
				node: { nodeId: "reflection-node-1" },
				rejectedResponses: [{ output: { complete: true, lessons: {} } }],
			},
		},
	};
}

describe("file evolution failure reporter", () => {
	it("stores private JSON history in a file named exactly after the job", async () => {
		const root = await mkdtemp(join(tmpdir(), "diffex-evolution-failures-"));
		temporaryDirectories.push(root);
		const directory = join(root, "evolution-failures");
		const reporter = new FileEvolutionFailureReporter(directory);
		const jobId = "job-bc929a21-9c10-46cd-a5b1-7ae55451ff4d";

		await reporter.record(failure(jobId, 0));
		await reporter.record(failure(jobId, 1));

		expect(await readdir(directory)).toEqual([jobId]);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		const path = join(directory, jobId);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			schemaVersion: 1,
			jobId,
			failures: [{ attempt: 0 }, { attempt: 1 }],
		});
	});

	it("rejects a job ID that could escape the failures directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "diffex-evolution-failures-"));
		temporaryDirectories.push(root);
		const reporter = new FileEvolutionFailureReporter(join(root, "evolution-failures"));

		await expect(reporter.record(failure("../job-escape", 0))).rejects.toThrow("Invalid evolution job ID");
	});
});
