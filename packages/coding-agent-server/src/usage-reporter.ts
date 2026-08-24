import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeUsageRecord {
	eventId: string;
	sessionId: string;
	ownerUserId: string;
	orgId: string;
	provider: string;
	model: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	occurredAt: number;
}

export interface RuntimeUsageReporter {
	record(event: RuntimeUsageRecord): void;
	flush(): Promise<void>;
	close(): Promise<void>;
}

export function createDurableUsageReporter(input: {
	endpoint: string;
	sharedSecret: string;
	outboxDirectory: string;
	retryIntervalMs?: number;
	fetch?: typeof fetch;
	onError?: (error: Error) => void;
}): RuntimeUsageReporter {
	const endpoint = new URL(input.endpoint);
	if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
		throw new TypeError("Runtime usage endpoint must use HTTPS");
	}
	if (Buffer.byteLength(input.sharedSecret) < 32) {
		throw new TypeError("Runtime usage shared secret must contain at least 32 bytes");
	}
	const retryIntervalMs = input.retryIntervalMs ?? 10_000;
	if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs <= 0) {
		throw new TypeError("Runtime usage retry interval must be positive");
	}
	mkdirSync(input.outboxDirectory, { recursive: true, mode: 0o700 });
	const fetchImpl = input.fetch ?? fetch;
	let closed = false;
	let flushPromise: Promise<void> | undefined;
	let flushRequested = false;

	const flush = (): Promise<void> => {
		flushRequested = true;
		if (flushPromise) return flushPromise;
		flushPromise = (async () => {
			do {
				flushRequested = false;
				await flushOutbox({
					endpoint,
					sharedSecret: input.sharedSecret,
					outboxDirectory: input.outboxDirectory,
					fetchImpl,
					onError: input.onError,
				});
			} while (flushRequested);
		})().finally(() => {
			flushPromise = undefined;
		});
		return flushPromise;
	};
	const timer = setInterval(() => {
		if (!closed) void flush();
	}, retryIntervalMs);
	timer.unref();
	void flush();

	return {
		record(event) {
			if (closed) throw new Error("Runtime usage reporter is closed");
			validateUsageRecord(event);
			const file = usageFile(input.outboxDirectory, event.eventId);
			if (!existsSync(file)) {
				writeFileSync(file, `${JSON.stringify(event)}\n`, {
					encoding: "utf8",
					mode: 0o600,
					flag: "wx",
				});
			}
			void flush();
		},
		flush,
		async close() {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			await flush();
		},
	};
}

async function flushOutbox(input: {
	endpoint: URL;
	sharedSecret: string;
	outboxDirectory: string;
	fetchImpl: typeof fetch;
	onError?: (error: Error) => void;
}): Promise<void> {
	const files = readdirSync(input.outboxDirectory)
		.filter((file) => file.endsWith(".json"))
		.sort();
	for (const file of files) {
		const path = join(input.outboxDirectory, file);
		try {
			const event = JSON.parse(readFileSync(path, "utf8")) as RuntimeUsageRecord;
			validateUsageRecord(event);
			const response = await input.fetchImpl(input.endpoint, {
				method: "POST",
				headers: {
					authorization: `Bearer ${input.sharedSecret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(event),
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) {
				throw new Error(`Runtime usage endpoint returned ${String(response.status)}`);
			}
			rmSync(path);
		} catch (error) {
			reportError(input.onError, error);
			return;
		}
	}
}

function usageFile(directory: string, eventId: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(eventId)) {
		throw new TypeError("Runtime usage eventId is not filesystem-safe");
	}
	return join(directory, `${eventId}.json`);
}

function validateUsageRecord(event: RuntimeUsageRecord): void {
	for (const value of [event.eventId, event.sessionId, event.ownerUserId, event.orgId, event.provider, event.model]) {
		if (typeof value !== "string" || value.length === 0) {
			throw new TypeError("Runtime usage identity fields must not be empty");
		}
	}
	for (const value of Object.values(event.usage)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new TypeError("Runtime usage values must be non-negative safe integers");
		}
	}
	if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) {
		throw new TypeError("Runtime usage occurredAt must be a timestamp");
	}
}

function reportError(observer: ((error: Error) => void) | undefined, error: unknown): void {
	try {
		observer?.(error instanceof Error ? error : new Error(String(error)));
	} catch {
		// Usage diagnostics never alter the durable retry state.
	}
}
