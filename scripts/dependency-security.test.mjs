import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CompleteRequestSchema } from "@modelcontextprotocol/sdk/types.js";

test("sandbox cryptography rejects extra nested RSA DigestAlgorithm fields", () => {
	const forge = createRequire(import.meta.resolve("@anthropic-ai/sandbox-runtime"))("node-forge");
	// An exponent of one exposes the encoded signature block directly to the verifier.
	const publicKey = forge.pki.rsa.setPublicKey(
		new forge.jsbn.BigInteger("f".repeat(256), 16),
		new forge.jsbn.BigInteger("1", 10),
	);
	const digest = forge.md.sha256.create().update("Diffex signature verification").digest().getBytes();
	const { asn1 } = forge;
	for (const extraField of [false, true]) {
		const algorithm = [
			asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
			asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
		];
		if (extraField) algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, ""));
		const digestInfo = asn1.toDer(
			asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
				asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithm),
				asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
			]),
		).getBytes();
		const signature = `\x00\x01${"\xff".repeat(128 - 3 - digestInfo.length)}\x00${digestInfo}`;
		if (extraField) assert.throws(() => publicKey.verify(digest, signature), /DigestInfo/);
		else assert.equal(publicKey.verify(digest, signature), true);
	}
});

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
