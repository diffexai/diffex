import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import lockfile from "proper-lockfile";
import type { EvolutionFailureRecord, EvolutionFailureReporter } from "#evolution";

interface EvolutionFailureFile {
	readonly schemaVersion: 1;
	readonly jobId: string;
	readonly failures: readonly EvolutionFailureRecord[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailureRecord(value: unknown, jobId: string): value is EvolutionFailureRecord {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		value.jobId === jobId &&
		typeof value.trigger === "string" &&
		typeof value.stage === "string" &&
		typeof value.outcome === "string" &&
		typeof value.reasonCode === "string" &&
		typeof value.failedAt === "string" &&
		typeof value.attempt === "number" &&
		isRecord(value.error)
	);
}

export class FileEvolutionFailureReporter implements EvolutionFailureReporter {
	readonly #directory: string;

	constructor(directory: string) {
		this.#directory = directory;
	}

	async #load(path: string, jobId: string): Promise<EvolutionFailureFile> {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (
				!isRecord(parsed) ||
				parsed.schemaVersion !== 1 ||
				parsed.jobId !== jobId ||
				!Array.isArray(parsed.failures) ||
				!parsed.failures.every((failure) => isFailureRecord(failure, jobId))
			) {
				throw new Error(`Evolution failure report at "${path}" is invalid`);
			}
			return { schemaVersion: 1, jobId, failures: parsed.failures };
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return { schemaVersion: 1, jobId, failures: [] };
			}
			throw error;
		}
	}

	async record(failure: EvolutionFailureRecord): Promise<void> {
		if (basename(failure.jobId) !== failure.jobId || !/^job-[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(failure.jobId)) {
			throw new Error(`Invalid evolution job ID "${failure.jobId}"`);
		}
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		const lockPath = join(this.#directory, ".write");
		const release = await lockfile.lock(lockPath, {
			lockfilePath: `${lockPath}.lock`,
			realpath: false,
			retries: { retries: 200, factor: 1, minTimeout: 5, maxTimeout: 25, randomize: true },
			stale: 30_000,
			update: 10_000,
		});
		try {
			const path = join(this.#directory, failure.jobId);
			const current = await this.#load(path, failure.jobId);
			const next: EvolutionFailureFile = {
				schemaVersion: 1,
				jobId: failure.jobId,
				failures: [...current.failures, failure],
			};
			const temporaryPath = join(this.#directory, `.${failure.jobId}.${randomUUID()}.tmp`);
			try {
				await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
					encoding: "utf8",
					flag: "wx",
					mode: 0o600,
				});
				await rename(temporaryPath, path);
			} catch (error) {
				await unlink(temporaryPath).catch((cleanupError: unknown) => {
					if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
						throw cleanupError;
					}
				});
				throw error;
			}
		} finally {
			await release();
		}
	}
}
