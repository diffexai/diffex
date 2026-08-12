import {
	type AgentSessionServices,
	createAgentSessionServices,
} from "../agent-session-services.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { SettingsManager } from "../settings-manager.ts";

export interface CreateSubagentServicesOptions {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
}

const SUBAGENT_SYSTEM_PROMPT = [
	"You are a subagent working on a focused task delegated by a parent agent.",
	"Work independently in the shared working directory and return a concise, complete result to the parent.",
	"You do not have access to the parent's transcript unless it is included in your task.",
	"Do not attempt to create or coordinate other agents.",
	"Other agents may use the same filesystem, so avoid unrelated edits and report files you change.",
].join("\n");

export function createSubagentServices(
	options: CreateSubagentServicesOptions,
): Promise<AgentSessionServices> {
	return createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime: options.modelRuntime,
		settingsManager: options.settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			reloadSettings: false,
			appendSystemPromptOverride: (base) => [...base, SUBAGENT_SYSTEM_PROMPT],
		},
	});
}
