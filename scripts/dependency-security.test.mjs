import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CompleteRequestSchema } from "@modelcontextprotocol/sdk/types.js";

test("MCP rejects oversized completions before validating every element", async () => {
	const client = new Client({ name: "security-test", version: "1.0.0" });
	const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { completions: {} } });
	server.setRequestHandler(CompleteRequestSchema, async () => ({
		completion: { values: Array(10_000).fill(0) },
	}));
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		await assert.rejects(
			client.complete({ ref: { type: "ref/prompt", name: "fixture" }, argument: { name: "value", value: "" } }),
			(error) => {
				assert.equal(error.issues.length, 1);
				assert.equal(error.issues[0].code, "too_big");
				assert.deepEqual(error.issues[0].path, ["completion", "values"]);
				return true;
			},
		);
	} finally {
		await client.close();
		await server.close();
	}
});

test("sandbox configuration keeps its validation contract with patched Zod", () => {
	const config = {
		network: { allowedDomains: ["github.com", "*.npmjs.org"], deniedDomains: ["blocked.example"] },
		filesystem: { denyRead: ["~/.ssh"], allowWrite: [".", "/tmp"], denyWrite: [".env"] },
		ignoreViolations: { "*": ["/tmp/fixture"] },
		ripgrep: { command: "rg", args: ["--hidden"] },
	};
	assert.deepEqual(SandboxRuntimeConfigSchema.parse(config), config);
	for (const domain of ["*", "*.com", "https://example.com", "example.com/path"]) {
		assert.equal(
			SandboxRuntimeConfigSchema.safeParse({
				...config,
				network: { ...config.network, allowedDomains: [domain] },
			}).success,
			false,
		);
	}
	assert.equal(
		SandboxRuntimeConfigSchema.safeParse({ ...config, ignoreViolations: { "*": [42] } }).success,
		false,
	);
});
