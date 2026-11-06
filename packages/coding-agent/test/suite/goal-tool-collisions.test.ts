import type { AgentTool } from "@diffexai/diffex-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness } from "./harness.ts";

it("uses the goal compaction tool while enabled and restores a same-named custom tool on exit", async () => {
	let customCalls = 0;
	let probeCalls = 0;
	const tools: AgentTool[] = [
		{
			name: "compact_block",
			label: "Custom compact",
			description: "A custom tool with the same name.",
			parameters: Type.Object({}),
			async execute() {
				customCalls++;
				return { content: [{ type: "text", text: "Custom result." }], details: {} };
			},
		},
		{
			name: "probe",
			label: "Probe",
			description: "A second custom tool.",
			parameters: Type.Object({}),
			async execute() {
				probeCalls++;
				return { content: [{ type: "text", text: "Probe result." }], details: {} };
			},
		},
	];
	const harness = await createHarness({ tools });
	try {
		const ordinaryCalls = () =>
			fauxAssistantMessage([fauxToolCall("compact_block", {}), fauxToolCall("probe", {})], {
				stopReason: "toolUse",
			});
		harness.setResponses([ordinaryCalls(), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Use the custom tools.");
		expect([customCalls, probeCalls]).toEqual([1, 1]);
		await harness.session.setGoalModeEnabled(true);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("compact_block", { start_id: "b001", end_id: "b001" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		]);
		await harness.session.prompt("Try goal compaction.");
		expect(customCalls).toBe(1);
		expect(harness.session.getGoalDiagnostics().compactionFailures).toBe(1);
		await harness.session.setGoalModeEnabled(false);
		harness.setResponses([ordinaryCalls(), fauxAssistantMessage("Done.")]);
		await harness.session.prompt("Use the custom tools again.");
		expect([customCalls, probeCalls]).toEqual([2, 2]);
	} finally {
		await harness.cleanup();
	}
});
