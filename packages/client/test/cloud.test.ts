import { describe, expect, it, vi } from "vitest";
import { type CloudFetch, type DiffexCloudApiError, DiffexCloudClient } from "../src/cloud.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION = {
	session_id: SESSION_ID,
	status: "running",
	created_at: "2026-08-23T00:00:00.000Z",
	updated_at: "2026-08-23T00:01:00.000Z",
};

function response(status: number, value?: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(value),
	};
}

describe("DiffexCloudClient", () => {
	it("uses bearer auth for the complete cloud session lifecycle", async () => {
		const fetch = vi
			.fn<CloudFetch>()
			.mockResolvedValueOnce(response(201, { session: SESSION }))
			.mockResolvedValueOnce(response(200, { sessions: [SESSION] }))
			.mockResolvedValueOnce(response(200, { session: SESSION }))
			.mockResolvedValueOnce(
				response(200, {
					attachment: {
						url: `wss://api.diffex.ai/v1/runtime/sessions/${SESSION_ID}?ticket=one-time`,
						expires_at: "2026-08-23T00:02:00.000Z",
						protocol_version: 1,
					},
				}),
			)
			.mockResolvedValueOnce(response(200, { session: { ...SESSION, status: "stopped" } }))
			.mockResolvedValueOnce(response(204));
		const client = new DiffexCloudClient({
			baseUrl: "https://api.diffex.ai",
			accessToken: async () => "access-secret",
			fetch,
		});

		await expect(client.createSession()).resolves.toEqual(SESSION);
		await expect(client.listSessions()).resolves.toEqual([SESSION]);
		await expect(client.getSession(SESSION_ID)).resolves.toEqual(SESSION);
		await expect(client.createAttachment(SESSION_ID)).resolves.toMatchObject({ protocol_version: 1 });
		await expect(client.stopSession(SESSION_ID)).resolves.toMatchObject({ status: "stopped" });
		await expect(client.deleteSession(SESSION_ID)).resolves.toBeUndefined();

		expect(fetch).toHaveBeenCalledTimes(6);
		for (const [, init] of fetch.mock.calls) {
			expect(init.headers.authorization).toBe("Bearer access-secret");
		}
	});

	it("turns structured API failures into typed errors without leaking credentials", async () => {
		const fetch = vi.fn<CloudFetch>().mockResolvedValue(
			response(429, {
				error: { code: "active_session_limit", message: "Active session limit reached", requestId: "req_1" },
			}),
		);
		const client = new DiffexCloudClient({
			baseUrl: "https://api.diffex.ai",
			accessToken: "access-secret",
			fetch,
		});

		await expect(client.createSession()).rejects.toEqual(
			expect.objectContaining<Partial<DiffexCloudApiError>>({
				status: 429,
				code: "active_session_limit",
				requestId: "req_1",
			}),
		);
	});

	it("rejects attachments for a different native protocol version", async () => {
		const fetch = vi.fn<CloudFetch>().mockResolvedValue(
			response(200, {
				attachment: {
					url: `wss://api.diffex.ai/v1/runtime/sessions/${SESSION_ID}?ticket=one-time`,
					expires_at: "2026-08-23T00:02:00.000Z",
					protocol_version: 2,
				},
			}),
		);
		const client = new DiffexCloudClient({ baseUrl: "https://api.diffex.ai", accessToken: "token", fetch });

		await expect(client.createAttachment(SESSION_ID)).rejects.toMatchObject({
			status: 409,
			code: "unsupported_protocol_version",
		});
	});

	it("resolves a fresh one-time attachment for each transport connection", async () => {
		const fetch = vi
			.fn<CloudFetch>()
			.mockResolvedValueOnce(
				response(200, {
					attachment: {
						url: "wss://api.diffex.ai/v1/runtime/sessions/first?ticket=first",
						expires_at: "2026-08-23T00:02:00.000Z",
						protocol_version: 1,
					},
				}),
			)
			.mockResolvedValueOnce(
				response(200, {
					attachment: {
						url: "wss://api.diffex.ai/v1/runtime/sessions/first?ticket=second",
						expires_at: "2026-08-23T00:03:00.000Z",
						protocol_version: 1,
					},
				}),
			);
		const opened: string[] = [];
		class FakeWebSocket {
			static readonly OPEN = 1;
			binaryType = "";
			bufferedAmount = 0;
			readyState = FakeWebSocket.OPEN;
			readonly #listeners = new Map<string, Array<(event: never) => void>>();
			constructor(url: string | URL) {
				opened.push(String(url));
				queueMicrotask(() => {
					this.#listeners.get("open")?.forEach((listener) => {
						listener(undefined as never);
					});
				});
			}
			send(): void {}
			close(): void {}
			addEventListener(type: string, listener: (event: never) => void): void {
				this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
			}
		}
		const client = new DiffexCloudClient({ baseUrl: "https://api.diffex.ai", accessToken: "token", fetch });
		const factory = client.createTransportFactory("first", { webSocket: FakeWebSocket });

		(await factory({ onData() {}, onClose() {}, onError() {} })).close();
		(await factory({ onData() {}, onClose() {}, onError() {} })).close();

		expect(opened).toEqual([
			"wss://api.diffex.ai/v1/runtime/sessions/first?ticket=first",
			"wss://api.diffex.ai/v1/runtime/sessions/first?ticket=second",
		]);
	});
});
