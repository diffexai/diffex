import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableUsageReporter, type RuntimeUsageRecord } from "../src/usage-reporter.ts";

const directories: string[] = [];
const EVENT: RuntimeUsageRecord = {
	eventId: "assistant-entry-1",
	sessionId: "session-1",
	ownerUserId: "user-1",
	orgId: "org-1",
	provider: "anthropic",
	model: "claude-opus-4-8",
	usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
	occurredAt: 1_000,
};

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable runtime usage reporter", () => {
	it("persists before delivery and removes the event only after acknowledgement", async () => {
		const outboxDirectory = temporaryDirectory();
		let resolveFetch!: (response: Response) => void;
		const fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		const reporter = createDurableUsageReporter({
			endpoint: "https://api.diffex.test/v1/runtime/sessions/session-1/usage",
			sharedSecret: "runtime-usage-shared-secret-for-tests",
			outboxDirectory,
			fetch,
		});

		reporter.record(EVENT);
		expect(readdirSync(outboxDirectory)).toEqual(["assistant-entry-1.json"]);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		resolveFetch(new Response(null, { status: 204 }));
		await reporter.flush();
		expect(readdirSync(outboxDirectory)).toEqual([]);
		await reporter.close();
	});

	it("keeps failed events and retries them after process restart", async () => {
		const outboxDirectory = temporaryDirectory();
		const failed = createDurableUsageReporter({
			endpoint: "https://api.diffex.test/v1/runtime/sessions/session-1/usage",
			sharedSecret: "runtime-usage-shared-secret-for-tests",
			outboxDirectory,
			fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
		});
		failed.record(EVENT);
		await failed.flush();
		expect(existsSync(join(outboxDirectory, "assistant-entry-1.json"))).toBe(true);
		await failed.close();

		const recovered = createDurableUsageReporter({
			endpoint: "https://api.diffex.test/v1/runtime/sessions/session-1/usage",
			sharedSecret: "runtime-usage-shared-secret-for-tests",
			outboxDirectory,
			fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
		});
		await recovered.flush();
		expect(readdirSync(outboxDirectory)).toEqual([]);
		await recovered.close();
	});
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "diffex-usage-outbox-"));
	directories.push(directory);
	return directory;
}
