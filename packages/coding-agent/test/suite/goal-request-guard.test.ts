import type { AgentTool } from "@diffexai/diffex-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@diffexai/diffex-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { goalNotes } from "./goal-harness.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

it("refreshes the goal catalog after a steering message is delivered", async () => {
	let harness: Harness;
	const tool: AgentTool = {
		name: "queue_steering",
		label: "Queue steering",
		description: "Queue a new user request during a tool call.",
		parameters: Type.Object({}),
		async execute() {
			await harness.session.steer("Include the new constraint.");
			return { content: [{ type: "text", text: "Queued." }], details: {} };
		},
	};
	harness = await createHarness({ tools: [tool] });
	try {
		await harness.session.setGoalModeEnabled(true);
		const requests: Context[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("queue_steering", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("Acknowledged.");
			},
		]);
		await harness.session.prompt("Start the investigation.");
		expect(requests).toHaveLength(1);
		const messages = requests[0].messages.map(getMessageText);
		const steering = messages.findIndex((message) => message.includes("Include the new constraint."));
		const latestNote = messages.findLastIndex((message) => message.includes("Context usage: approximately"));
		expect(steering).toBeGreaterThanOrEqual(0);
		expect(latestNote).toBeGreaterThan(steering);
		expect(goalNotes(requests[0])).toHaveLength(3);
	} finally {
		await harness.cleanup();
	}
});
