import type { ThinkingLevel } from "@earendil-works/diffex-agent-core";
import type { Model } from "@earendil-works/diffex-ai";
import type { AgentSession } from "../agent-session.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../agent-session-services.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { allToolNames, type ToolName } from "../tools/index.ts";

export interface CreateSubagentServicesOptions {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
}

export interface SubagentSessionConfig {
	readonly cwd: string;
	readonly agentDir: string;
	readonly modelRuntime: ModelRuntime;
	readonly settingsManager: SettingsManager;
	readonly model: Model<any>;
	readonly thinkingLevel: ThinkingLevel;
	readonly tools: readonly ToolName[];
	readonly parentSession: string;
}

const SUBAGENT_SYSTEM_PROMPT = [
	"You are a subagent working on a focused task delegated by a parent agent.",
	"Work independently in the shared working directory and return a concise, complete result to the parent.",
	"You do not have access to the parent's transcript unless it is included in your task.",
	"Do not attempt to create or coordinate other agents.",
	"Other agents may use the same filesystem, so avoid unrelated edits and report files you change.",
].join("\n");

export function createSubagentServices(options: CreateSubagentServicesOptions): Promise<AgentSessionServices> {
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

export function captureSubagentSessionConfig(parent: AgentSession, agentDir: string): SubagentSessionConfig {
	const model = parent.model;
	if (!model) {
		throw new Error("Cannot create a subagent session without a selected parent model");
	}

	const toolsByName = new Map(parent.getAllTools().map((tool) => [tool.name, tool]));
	const tools = Object.freeze(
		parent
			.getActiveToolNames()
			.filter(
				(name): name is ToolName =>
					allToolNames.has(name as ToolName) && toolsByName.get(name)?.sourceInfo.source === "builtin",
			),
	);

	return Object.freeze({
		cwd: parent.sessionManager.getCwd(),
		agentDir,
		modelRuntime: parent.modelRuntime,
		settingsManager: parent.settingsManager,
		model,
		thinkingLevel: parent.thinkingLevel,
		tools,
		parentSession: parent.sessionId,
	});
}

export async function createSubagentSession(
	config: SubagentSessionConfig,
	options: { signal?: AbortSignal } = {},
): Promise<AgentSession> {
	options.signal?.throwIfAborted();
	const services = await createSubagentServices({
		cwd: config.cwd,
		agentDir: config.agentDir,
		modelRuntime: config.modelRuntime,
		settingsManager: config.settingsManager,
	});
	options.signal?.throwIfAborted();

	const sessionManager = SessionManager.inMemory(config.cwd, { parentSession: config.parentSession });
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: config.model,
		thinkingLevel: config.thinkingLevel,
		tools: [...config.tools],
		scopedModels: [],
		customTools: [],
		subagents: false,
	});

	try {
		options.signal?.throwIfAborted();
	} catch (error) {
		session.dispose();
		throw error;
	}
	return session;
}
