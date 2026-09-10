#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@diffexai/diffex";
import { createWebSocketServer } from "@diffexai/diffex-server/websocket";
import { createHostedCodingAgentService } from "./service.ts";
import { createDurableUsageReporter } from "./usage-reporter.ts";

const sessionId = requiredEnvironment("DIFFEX_SESSION_ID");
const workspace = requiredEnvironment("DIFFEX_WORKSPACE");
const sharedSecret = requiredEnvironment("DIFFEX_RUNTIME_SHARED_SECRET");
if (Buffer.byteLength(sharedSecret) < 32) {
	throw new Error("DIFFEX_RUNTIME_SHARED_SECRET must contain at least 32 bytes");
}
const port = integerEnvironment("PORT", 8787);
const host = process.env.HOST ?? "0.0.0.0";
const path = process.env.DIFFEX_RUNTIME_PATH ?? "/runtime";
const agentDir = process.env.DIFFEX_AGENT_DIR;
const modelProvider = requiredEnvironment("DIFFEX_MODEL_PROVIDER");
const modelId = requiredEnvironment("DIFFEX_MODEL_ID");
const modelApiKey = requiredEnvironment("DIFFEX_MODEL_API_KEY");
const modelRuntime = await ModelRuntime.create({
	...(agentDir
		? {
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
			}
		: {}),
	refreshOnCreate: false,
});
await modelRuntime.setRuntimeApiKey(modelProvider, modelApiKey);
delete process.env.DIFFEX_MODEL_API_KEY;
delete process.env.DIFFEX_RUNTIME_SHARED_SECRET;
const runtimeStateDirectory = requiredEnvironment("DIFFEX_RUNTIME_STATE_DIR");
const usageReporter = createDurableUsageReporter({
	endpoint: requiredEnvironment("DIFFEX_USAGE_ENDPOINT"),
	sharedSecret,
	outboxDirectory: join(runtimeStateDirectory, "usage-outbox"),
	onError(error) {
		process.stderr.write(`UsageReporterError: ${error.message}\n`);
	},
});

const service = await createHostedCodingAgentService({
	sessionId,
	cwd: workspace,
	agentDir,
	sessionDir: process.env.DIFFEX_SESSION_DIR,
	modelRuntime,
	defaultModel: { provider: modelProvider, id: modelId },
	ownerUserId: requiredEnvironment("DIFFEX_OWNER_USER_ID"),
	orgId: requiredEnvironment("DIFFEX_ORG_ID"),
	usageReporter,
});
const server = createWebSocketServer(service, {
	host,
	port,
	path,
	authorize(request) {
		const authorization = request.headers.authorization;
		if (!authorization?.startsWith("Bearer ")) return { authorized: false };
		return { authorized: secretsEqual(authorization.slice(7), sharedSecret) };
	},
	onError(error) {
		process.stderr.write(`${error.name}: ${error.message}\n`);
	},
});

await server.start();
process.stdout.write(`Diffex runtime server listening for session ${sessionId}\n`);

let closing = false;
const close = async (): Promise<void> => {
	if (closing) return;
	closing = true;
	await server.close();
	await usageReporter.close();
};
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function integerEnvironment(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
		throw new Error(`${name} must be an integer from 1 through 65535`);
	}
	return value;
}

function secretsEqual(candidate: string, expected: string): boolean {
	const candidateBytes = Buffer.from(candidate);
	const expectedBytes = Buffer.from(expected);
	return candidateBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(candidateBytes, expectedBytes);
}
