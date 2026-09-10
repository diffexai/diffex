import type { Context } from "@diffexai/diffex-ai";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import {
	captureSubagentSessionConfig,
	createSubagentSession,
	type SubagentSessionConfig,
} from "../../src/core/subagents/services.ts";
import type { SubagentStatus } from "../../src/core/subagents/types.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

export interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

export function getLastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n");
	}
	return "";
}

export async function waitForStatus(
	controller: SubagentController,
	name: string,
	status: SubagentStatus,
): Promise<void> {
	while (true) {
		const snapshot = controller.snapshot();
		if (snapshot.agents.find((agent) => agent.name === name)?.status === status) return;
		const result = await controller.waitForChange(snapshot.revision, { timeoutMs: 1_000 });
		if (result.reason !== "changed") {
			throw new Error(`Timed out waiting for ${name} to become ${status}`);
		}
	}
}

export interface SubagentTestHarness {
	readonly harness: Harness;
	readonly controller: SubagentController;
	readonly config: SubagentSessionConfig;
	readonly createSession: (signal: AbortSignal) => Promise<AgentSession>;
	cleanup(): Promise<void>;
}

export async function createSubagentTestHarness(
	maxConcurrent = 1,
	options: HarnessOptions = {},
): Promise<SubagentTestHarness> {
	const harness = await createHarness({ settings: { retry: { enabled: false } }, ...options });
	const controller = new SubagentController({ maxConcurrent });
	const config = captureSubagentSessionConfig(harness.session, harness.tempDir);
	return {
		harness,
		controller,
		config,
		createSession: (signal) => createSubagentSession(config, { signal }),
		async cleanup() {
			await controller.shutdown();
			await harness.cleanup();
		},
	};
}
