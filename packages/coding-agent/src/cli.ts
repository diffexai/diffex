#!/usr/bin/env node
import { runBillingCommand } from "./cli/billing-command.ts";
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.DIFFEX_CODING_AGENT = "true";
process.env.AI_AGENT = "diffex";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

const args = process.argv.slice(2);
if (args[0] === "billing") {
	void runBillingCommand(args).then((code) => {
		process.exitCode = code ?? 1;
	});
} else {
	main(args);
}
