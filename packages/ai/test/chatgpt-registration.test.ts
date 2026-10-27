import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatGPTRegistrationStore } from "../src/auth/oauth/chatgpt-registration.ts";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "diffex-registration-store-"));
	vi.stubEnv("DIFFEX_CODING_AGENT_DIR", directory);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

it("keeps registration metadata in the configured storage directory", () => {
	const store = new ChatGPTRegistrationStore();
	const registration = { clientId: "oaiapp_diffex_test", subject: "test-account" };
	store.save(registration);
	expect(store.list()).toEqual([registration]);
	expect(readdirSync(join(directory, "chatgpt"))).toEqual(["oaiapp_diffex_test.json"]);
});

it.each(["../outside", "oaiapp_../../outside", "oaiapp_test/outside", "oaiapp_test\\outside"])(
	"rejects a client ID containing a path: %s",
	(clientId) => {
		const store = new ChatGPTRegistrationStore();
		expect(() => store.save({ clientId })).toThrow("Invalid issued ChatGPT client ID");
		expect(readdirSync(join(directory, "chatgpt"))).toEqual([]);
	},
);
