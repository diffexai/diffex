/**
 * Custom entry rendering example.
 *
 * Shows how to render durable extension data inside the chat without sending it
 * to the LLM. Custom entries are stored in the session via diffex.appendEntry() and
 * rendered in interactive mode via diffex.registerEntryRenderer().
 *
 * Usage: /status-card [message]
 */

import type { ExtensionAPI } from "@diffexai/diffex";
import { Box, Text } from "@diffexai/diffex-tui";

interface StatusCardData {
	message: string;
	timestamp: number;
}

export default function (diffex: ExtensionAPI) {
	diffex.registerEntryRenderer<StatusCardData>("status-card", (entry, { expanded }, theme) => {
		const data = entry.data ?? { message: "No data", timestamp: Date.now() };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", "[status]")} ${data.message}`, 0, 0));

		if (expanded) {
			box.addChild(new Text(theme.fg("dim", new Date(data.timestamp).toLocaleString()), 0, 0));
		}

		return box;
	});

	diffex.registerCommand("status-card", {
		description: "Render a durable status card that is not sent to the LLM",
		handler: async (args) => {
			diffex.appendEntry<StatusCardData>("status-card", {
				message: args.trim() || "Status card",
				timestamp: Date.now(),
			});
		},
	});
}
