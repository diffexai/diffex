import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("starts Diffex registration through a loopback callback and cancels without hanging", async () => {
	const dir = mkdtempSync(join(tmpdir(), "diffex-chatgpt-"));
	dirs.push(dir);
	vi.stubEnv("DIFFEX_CODING_AGENT_DIR", dir);
	const controller = new AbortController();
	let authorization: URL | undefined;
	const login = openaiCodexOAuth.login({
		signal: controller.signal,
		prompt: async (prompt) => {
			if (prompt.type === "select") return "browser";
			return new Promise<string>(() => {});
		},
		notify: (event) => {
			if (event.type === "auth_url") authorization = new URL(event.url);
		},
	});
	const outcome = login.catch((error: unknown) => error);
	try {
		await vi.waitFor(() => expect(authorization).toBeDefined());
		expect(authorization?.pathname).toBe("/api/accounts/authorize");
		expect(authorization?.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(authorization?.searchParams.get("agent_name_hint")).toBe("Diffex");
		expect(authorization?.searchParams.get("ext_agent_host_id")).toBeTruthy();
		expect(authorization?.searchParams.get("nonce")).toBeTruthy();
		expect(new URL(authorization?.searchParams.get("redirect_uri") ?? "").hostname).toBe("127.0.0.1");
	} finally {
		controller.abort();
		await outcome;
	}
});
