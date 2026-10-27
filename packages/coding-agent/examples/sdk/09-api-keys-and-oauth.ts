/**
 * API Keys and OAuth
 *
 * Configure provider auth through ModelRuntime.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager } from "@diffexai/diffex";

const modelRuntime = await ModelRuntime.create();
const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime,
});
console.log("Session with default model runtime");
await defaultAuthSession.dispose();

const customDirectory = join(homedir(), ".diffex", "examples", "custom-auth");
const customRuntime = await ModelRuntime.create({
	authPath: join(customDirectory, "auth.json"),
	modelsPath: join(customDirectory, "models.json"),
});
const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime: customRuntime,
});
console.log("Session with custom auth and models locations");
await customAuthSession.dispose();

await modelRuntime.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	modelRuntime,
});
console.log("Session with runtime API key override");
await runtimeKeySession.dispose();
