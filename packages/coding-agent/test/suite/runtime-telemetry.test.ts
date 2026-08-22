import { InMemoryTelemetryContext } from "@earendil-works/diffex-agent-core";
import { fauxAssistantMessage } from "@earendil-works/diffex-ai";
import {
	HarnessStateStore,
	type HarnessVersionBundle,
	INITIAL_HARNESS_VERSION_METADATA,
} from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentController } from "../../src/core/subagents/controller.ts";
import { captureSubagentSessionConfig } from "../../src/core/subagents/services.ts";
import type { SubagentStatus } from "../../src/core/subagents/types.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./harness.ts";

async function waitForStatus(controller: SubagentController, name: string, status: SubagentStatus): Promise<void> {
	while (true) {
		const snapshot = controller.snapshot();
		if (snapshot.agents.find((agent) => agent.name === name)?.status === status) return;
		const change = await controller.waitForChange(snapshot.revision, { timeoutMs: 1_000 });
		if (change.reason !== "changed") throw new Error(`Timed out waiting for ${name} to become ${status}`);
	}
}

describe("coding-agent runtime telemetry", () => {
	const harnesses: Harness[] = [];
	const controllers: SubagentController[] = [];

	afterEach(async () => {
		while (controllers.length > 0) await controllers.pop()?.shutdown();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("nests retried agent runs under one prompt operation", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const harness = await createHarness({
			telemetryContext: telemetry,
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("retry once");

		const spans = telemetry.getSpans();
		const operation = spans.find(
			(span) =>
				span.name === "diffex.coding_agent.operation" && span.attributes["diffex.operation.kind"] === "prompt",
		);
		expect(operation).toMatchObject({
			parentId: null,
			attributes: { "diffex.operation.outcome": "completed" },
		});
		expect(operation?.attributes["diffex.operation.id"]).toEqual(expect.any(String));
		expect(spans.filter((span) => span.name === "diffex.agent.run").map((span) => span.parentId)).toEqual([
			operation?.id,
			operation?.id,
		]);
		expect(spans.find((span) => span.name === "diffex.coding_agent.retry")).toMatchObject({
			parentId: operation?.id,
			attributes: {
				"diffex.retry.attempt": 1,
				"diffex.retry.outcome": "resumed",
			},
		});
		expect(spans.find((span) => span.name === "diffex.coding_agent.extension_hook")).toMatchObject({
			attributes: {
				"diffex.extension.hook": "before_agent_start",
				"diffex.extension.outcome": "completed",
			},
		});
	});

	it("records provider-backed compaction at dispatch", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const harness = await createHarness({
			telemetryContext: telemetry,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("captured summary"),
			fauxAssistantMessage("captured turn prefix"),
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		await harness.session.compact();

		const spans = telemetry.getSpans();
		const operation = spans.find(
			(span) =>
				span.name === "diffex.coding_agent.operation" && span.attributes["diffex.operation.kind"] === "compaction",
		);
		expect(operation).toMatchObject({ attributes: { "diffex.operation.outcome": "completed" } });
		expect(spans.find((span) => span.name === "diffex.ai.request" && span.parentId === operation?.id)).toMatchObject({
			attributes: {
				"diffex.ai.response.stop_reason": "stop",
				"diffex.ai.streaming": true,
			},
		});
	});

	it("marks an interrupted prompt and agent run as aborted", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const harness = await createHarness({ telemetryContext: telemetry });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
		const sawUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "message_update") return;
				unsubscribe();
				resolve();
			});
		});

		const prompt = harness.session.prompt("interrupt me");
		await sawUpdate;
		await harness.session.abort();
		await prompt;

		const spans = telemetry.getSpans();
		expect(
			spans.find(
				(span) =>
					span.name === "diffex.coding_agent.operation" && span.attributes["diffex.operation.kind"] === "prompt",
			),
		).toMatchObject({
			status: { status: "error" },
			attributes: { "diffex.operation.outcome": "aborted" },
		});
		expect(spans.find((span) => span.name === "diffex.agent.run")).toMatchObject({
			status: { status: "error" },
			attributes: { "diffex.agent.outcome": "aborted" },
		});
	});

	it("records a completed child-agent run with a stable id", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const child = await createHarness({ telemetryContext: telemetry });
		harnesses.push(child);
		child.setResponses([fauxAssistantMessage("child complete")]);
		const controller = new SubagentController({ maxConcurrent: 1, telemetryContext: telemetry });
		controllers.push(controller);

		controller.spawn("worker", "focused task", async () => child.session);
		await waitForStatus(controller, "worker", "idle");

		const run = telemetry
			.getSpans()
			.find(
				(span) =>
					span.name === "diffex.coding_agent.subagent" && span.attributes["diffex.subagent.action"] === "run",
			);
		expect(run).toMatchObject({
			attributes: {
				"diffex.subagent.name": "worker",
				"diffex.subagent.outcome": "completed",
			},
		});
		expect(run?.attributes["diffex.subagent.id"]).toEqual(expect.any(String));
	});

	it("captures the parent harness snapshot and telemetry context for child sessions", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const bootstrap = await createHarness();
		harnesses.push(bootstrap);
		const store = new HarnessStateStore(bootstrap.tempDir);
		const version = `sha256:${"1".repeat(64)}`;
		const bundle: HarnessVersionBundle = {
			state: { memory: "captured memory" },
			manifest: {
				schemaVersion: 1,
				version,
				base: null,
				metadata: INITIAL_HARNESS_VERSION_METADATA,
				artifacts: [],
			},
		};
		const harness = await createHarness({
			telemetryContext: telemetry,
			harnessStateStore: store,
			harnessVersionBundle: bundle,
		});
		harnesses.push(harness);

		const captured = captureSubagentSessionConfig(harness.session, harness.tempDir);

		expect(captured.harnessStateStore).toBe(store);
		expect(captured.harnessVersionBundle).toBe(bundle);
		expect(captured.telemetryContext).toBe(telemetry);
	});

	it("records terminal and artifact facts without command or content payloads", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const harness = await createHarness({ telemetryContext: telemetry });
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async () => ({ exitCode: 0 }),
		};

		await harness.session.executeBash("private command", undefined, { operations });
		harness.session.exportToJsonl(`${harness.tempDir}/session-export.jsonl`);
		await Promise.resolve();

		const spans = telemetry.getSpans();
		expect(spans.find((span) => span.name === "diffex.coding_agent.terminal")).toMatchObject({
			attributes: {
				"diffex.terminal.exit_code": 0,
				"diffex.terminal.outcome": "completed",
			},
		});
		expect(spans.find((span) => span.name === "diffex.coding_agent.artifact")).toMatchObject({
			attributes: {
				"diffex.artifact.kind": "jsonl",
				"diffex.artifact.outcome": "written",
			},
		});
		expect(JSON.stringify(spans)).not.toContain("private command");
	});
});
