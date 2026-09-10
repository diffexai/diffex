import type { TelemetryContext, ThinkingLevel } from "@diffexai/diffex-agent-core";
import type { Model } from "@diffexai/diffex-ai";
import { clampThinkingLevel } from "@diffexai/diffex-ai/compat";
import type { HarnessStateStore, HarnessVersionBundle } from "@diffexai/diffex-harness-state";
import type { AgentSession } from "../agent-session.ts";
import {
	type AgentSessionServices,
	createAgentSessionServices,
	createInternalAgentSessionFromServices,
} from "../agent-session-services.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { allToolNames, type ToolName } from "../tools/index.ts";
import { createEscalateToParentTool } from "../tools/subagents.ts";
import {
	RootLocalEphemeralSubagentSessionManagerFactory,
	type SubagentSessionManagerFactory,
} from "./session-manager-factory.ts";
import { markFixedHarnessSubagentSession } from "./session-runtime.ts";
import type { CapturedSubagentConfig, SubagentEscalationCallback, SubagentSpawnOrigin } from "./types.ts";

export interface CreateSubagentServicesOptions {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	harnessStateStore?: HarnessStateStore;
	harnessVersionBundle?: HarnessVersionBundle;
	telemetryContext?: TelemetryContext;
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
	readonly sourceSessionManager: SessionManager;
	readonly harnessStateStore?: HarnessStateStore;
	readonly harnessVersionBundle?: HarnessVersionBundle;
	readonly telemetryContext?: TelemetryContext;
}

export interface CreateSubagentSessionOptions {
	readonly signal?: AbortSignal;
	readonly childName?: string;
	readonly origin?: SubagentSpawnOrigin;
	readonly sessionManagerFactory?: SubagentSessionManagerFactory;
	readonly sessionManager?: SessionManager;
	readonly escalateToParent?: SubagentEscalationCallback;
}

export interface ResolvedRestoredSubagentConfig {
	readonly sessionConfig: SubagentSessionConfig;
	readonly persistedConfig: CapturedSubagentConfig;
	readonly warning?: string;
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
		harnessStateStore: options.harnessStateStore,
		harnessVersionBundle: options.harnessVersionBundle,
		telemetryContext: options.telemetryContext,
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
		sourceSessionManager: parent.sessionManager,
		harnessStateStore: parent.harnessStateStore,
		harnessVersionBundle: parent.harnessVersionBundle,
		telemetryContext: parent.agent.telemetryContext,
	});
}

export function capturePersistedSubagentConfig(config: SubagentSessionConfig): CapturedSubagentConfig {
	return Object.freeze({
		model: Object.freeze({ provider: config.model.provider, id: config.model.id }),
		thinkingLevel: config.thinkingLevel,
		tools: config.tools,
		harnessRevision: config.harnessVersionBundle?.manifest.version ?? null,
	});
}

export async function resolveRestoredSubagentConfig(
	parent: AgentSession,
	agentDir: string,
	captured: CapturedSubagentConfig,
	childName: string,
): Promise<ResolvedRestoredSubagentConfig> {
	const current = captureSubagentSessionConfig(parent, agentDir);
	const unavailable: string[] = [];
	const model = current.modelRuntime.getModel(captured.model.provider, captured.model.id);
	if (!model) unavailable.push(`model ${captured.model.provider}/${captured.model.id} is unavailable`);
	else if (clampThinkingLevel(model, captured.thinkingLevel) !== captured.thinkingLevel) {
		unavailable.push(`thinking level ${captured.thinkingLevel} is unavailable`);
	}

	const availableTools = new Set(
		parent
			.getAllTools()
			.filter((tool) => tool.sourceInfo.source === "builtin")
			.map((tool) => tool.name),
	);
	const missingTools = captured.tools.filter((tool) => !availableTools.has(tool));
	if (missingTools.length > 0) unavailable.push(`tools ${missingTools.join(", ")} are unavailable`);

	let harnessVersionBundle: HarnessVersionBundle | undefined;
	if (captured.harnessRevision !== null) {
		if (current.harnessVersionBundle?.manifest.version === captured.harnessRevision) {
			harnessVersionBundle = current.harnessVersionBundle;
		} else {
			try {
				const listing = await current.harnessStateStore?.listVersions();
				harnessVersionBundle = listing?.versions.find(
					(bundle) => bundle.manifest.version === captured.harnessRevision,
				);
			} catch {
				// The complete current parent configuration is selected below.
			}
			if (!harnessVersionBundle) unavailable.push(`harness revision ${captured.harnessRevision} is unavailable`);
		}
	}

	if (!model || unavailable.length > 0) {
		return {
			sessionConfig: current,
			persistedConfig: capturePersistedSubagentConfig(current),
			warning: `Persisted subagent ${childName} configuration is unusable (${unavailable.join("; ")}); using the complete current parent configuration`,
		};
	}

	const sessionConfig = Object.freeze({
		...current,
		model,
		thinkingLevel: captured.thinkingLevel,
		tools: captured.tools,
		harnessVersionBundle,
	});
	return { sessionConfig, persistedConfig: captured };
}

export async function createSubagentSession(
	config: SubagentSessionConfig,
	options: CreateSubagentSessionOptions = {},
): Promise<AgentSession> {
	options.signal?.throwIfAborted();
	const services = await createSubagentServices({
		cwd: config.cwd,
		agentDir: config.agentDir,
		modelRuntime: config.modelRuntime,
		settingsManager: config.settingsManager,
		harnessStateStore: config.harnessStateStore,
		harnessVersionBundle: config.harnessVersionBundle,
		telemetryContext: config.telemetryContext,
	});
	options.signal?.throwIfAborted();

	const sessionManager =
		options.sessionManager ??
		(options.sessionManagerFactory ?? new RootLocalEphemeralSubagentSessionManagerFactory()).create(
			Object.freeze({
				childName: options.childName ?? "subagent",
				sourceSessionManager: config.sourceSessionManager,
				cwd: config.cwd,
				parentSessionId: config.parentSession,
				origin: options.origin ?? Object.freeze({ type: "programmatic", contextEntryId: null }),
			}),
		);
	markFixedHarnessSubagentSession(sessionManager);
	const { session } = await createInternalAgentSessionFromServices(
		{
			services,
			sessionManager,
			model: config.model,
			thinkingLevel: config.thinkingLevel,
			tools: [...config.tools],
			scopedModels: [],
			customTools: [],
			subagents: false,
		},
		options.escalateToParent
			? [createEscalateToParentTool(options.escalateToParent) as unknown as ToolDefinition]
			: undefined,
	);

	try {
		options.signal?.throwIfAborted();
	} catch (error) {
		await session.dispose();
		throw error;
	}
	return session;
}
