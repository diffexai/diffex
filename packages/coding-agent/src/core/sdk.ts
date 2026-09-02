import { join } from "node:path";
import {
	Agent,
	type AgentMessage,
	NOOP_TELEMETRY_CONTEXT,
	setDefaultStreamFn,
	type TelemetryContext,
	type ThinkingLevel,
} from "@earendil-works/diffex-agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/diffex-ai/compat";
import type { HarnessStateStore, HarnessVersionBundle } from "@earendil-works/diffex-harness-state";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import type { AgentSessionLifecycleObserver } from "./agent-session-lifecycle.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { loadWorkspaceHarnessState, resolveHarnessWorkspace } from "./harness-state-runtime.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, persistSessionState, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { type PreparedSubagentWake, SubagentController } from "./subagents/controller.ts";
import {
	type ChildSnapshotV1,
	encodeSubagentRosterSnapshot,
	ParentOwnedSubagentSessionStore,
	readSelectedBranchSubagentRoster,
	SUBAGENT_ROSTER_CUSTOM_TYPE,
} from "./subagents/persistence.ts";
import { reportSubagentRuntimeWarning } from "./subagents/runtime-diagnostics.ts";
import {
	capturePersistedSubagentConfig,
	captureSubagentSessionConfig,
	createSubagentSession,
	type ResolvedRestoredSubagentConfig,
	resolveRestoredSubagentConfig,
} from "./subagents/services.ts";
import { RootLocalEphemeralSubagentSessionManagerFactory } from "./subagents/session-manager-factory.ts";
import type { SubagentEscalationCallback } from "./subagents/types.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createUpdatePlanTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import Diffex AI compat itself.
setDefaultStreamFn(streamSimple);

const DEFAULT_SUBAGENT_CONCURRENCY = 4;
const RESERVED_SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "agent_action", "agents", "escalate_to_parent"]);

export interface SubagentOptions {
	/** Maximum number of child agents that may run concurrently. Default: 4 */
	maxConcurrent?: number;
}

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.diffex/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write, update_plan)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, Diffex enables the default built-in tools (read, bash, edit, write, update_plan)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];
	/** Child-agent coordination. Enabled by default with a concurrency limit of 4. */
	subagents?: false | SubagentOptions;

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Preloaded global harness store. Primarily used by runtime service composition. */
	harnessStateStore?: HarnessStateStore;
	/** Activated harness revision from the preloaded store. */
	harnessVersionBundle?: HarnessVersionBundle;
	/** Keep the supplied harness revision fixed instead of following the global selection. */
	pinHarnessVersion?: boolean;
	/** Optional parent for passive runtime telemetry. */
	telemetryContext?: TelemetryContext;
	/** Optional process-owned observer for durable lifecycle boundaries. */
	lifecycleObserver?: AgentSessionLifecycleObserver;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** Non-fatal warning when optional harness state could not be activated. */
	harnessStateWarning?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createUpdatePlanTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function normalizeSubagentOptions(value: unknown): false | Required<SubagentOptions> {
	if (value === false) return false;
	if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
		throw new TypeError("subagents must be false or an options object");
	}
	const options = value as SubagentOptions | undefined;
	if (options) {
		for (const key of Object.keys(options)) {
			if (key !== "maxConcurrent") {
				throw new Error(`Unknown subagents option: ${key}`);
			}
		}
	}
	const maxConcurrent = options?.maxConcurrent ?? DEFAULT_SUBAGENT_CONCURRENCY;
	if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
		throw new RangeError("subagents.maxConcurrent must be a positive integer");
	}
	return { maxConcurrent };
}

function assertNoReservedSubagentTools(customTools: readonly ToolDefinition[] | undefined): void {
	for (const tool of customTools ?? []) {
		if (RESERVED_SUBAGENT_TOOL_NAMES.has(tool.name)) {
			throw new Error(`Custom tool name is reserved for subagent coordination: ${tool.name}`);
		}
	}
}

function createRootSubagentController(
	maxConcurrent: number,
	agentDir: string,
	telemetryContext: TelemetryContext,
	parentSessionManager: SessionManager,
): SubagentController {
	const sessionManagerFactory = new RootLocalEphemeralSubagentSessionManagerFactory();
	return new SubagentController({
		maxConcurrent,
		telemetryContext,
		restoreRoster: (controller, parent) => restoreRootSubagents(controller, parent, agentDir, parentSessionManager),
		captureSession: (parent, childName, origin) => {
			const config = captureSubagentSessionConfig(parent, agentDir);
			const sessionManager = sessionManagerFactory.create(
				Object.freeze({
					childName,
					sourceSessionManager: config.sourceSessionManager,
					cwd: config.cwd,
					parentSessionId: config.parentSession,
					origin,
				}),
			);
			return Object.freeze({
				sessionManager,
				config: capturePersistedSubagentConfig(config),
				createSession: (signal: AbortSignal, escalateToParent?: SubagentEscalationCallback) =>
					createSubagentSession(config, {
						signal,
						childName,
						origin,
						sessionManager,
						escalateToParent,
					}),
			});
		},
		persistRoster: parentSessionManager.isPersisted()
			? (agents, admission) => {
					const previousLeafId = parentSessionManager.getLeafId();
					try {
						parentSessionManager.appendCustomEntry(
							SUBAGENT_ROSTER_CUSTOM_TYPE,
							encodeSubagentRosterSnapshot(agents),
						);
						if (admission) persistSessionState(parentSessionManager);
					} catch (error) {
						if (previousLeafId === null) parentSessionManager.resetLeaf();
						else parentSessionManager.branch(previousLeafId);
						throw error;
					}
				}
			: undefined,
	});
}

function createPreparedSubagentWake(
	childName: string,
	sessionManager: SessionManager,
	resolved: ResolvedRestoredSubagentConfig,
): PreparedSubagentWake {
	return Object.freeze({
		sessionManager,
		config: resolved.persistedConfig,
		...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
		createSession: (signal: AbortSignal, escalateToParent?: SubagentEscalationCallback) =>
			createSubagentSession(resolved.sessionConfig, { signal, childName, sessionManager, escalateToParent }),
	});
}

async function createReplacementSubagentWake(
	parent: AgentSession,
	agentDir: string,
	store: ParentOwnedSubagentSessionStore,
	childName: string,
): Promise<PreparedSubagentWake> {
	const sessionConfig = captureSubagentSessionConfig(parent, agentDir);
	const sessionManager = store.createChild(childName);
	return createPreparedSubagentWake(childName, sessionManager, {
		sessionConfig,
		persistedConfig: capturePersistedSubagentConfig(sessionConfig),
	});
}

async function prepareRestoredSubagentWake(
	parent: AgentSession,
	agentDir: string,
	store: ParentOwnedSubagentSessionStore,
	snapshot: ChildSnapshotV1,
): Promise<PreparedSubagentWake> {
	const resolved = await resolveRestoredSubagentConfig(parent, agentDir, snapshot.config, snapshot.name);
	if (resolved.warning) reportSubagentRuntimeWarning(parent.sessionManager, resolved.warning);
	try {
		return createPreparedSubagentWake(
			snapshot.name,
			store.openChild(snapshot.name, snapshot.childSessionId, snapshot.childLeafId),
			resolved,
		);
	} catch (error) {
		const message = `Persisted subagent ${snapshot.name} history became unavailable: ${error instanceof Error ? error.message : String(error)}; creating a replacement child session`;
		reportSubagentRuntimeWarning(parent.sessionManager, message);
		const replacement = await createReplacementSubagentWake(parent, agentDir, store, snapshot.name);
		return Object.freeze({ ...replacement, warning: message });
	}
}

function restoreRootSubagents(
	controller: SubagentController,
	parent: AgentSession,
	agentDir: string,
	parentSessionManager: SessionManager,
): void {
	if (!parentSessionManager.isPersisted()) return;
	const roster = readSelectedBranchSubagentRoster(parentSessionManager);
	for (const warning of roster.warnings) reportSubagentRuntimeWarning(parentSessionManager, warning);
	if (!roster.found || roster.children.length === 0) return;

	let store: ParentOwnedSubagentSessionStore;
	try {
		store = new ParentOwnedSubagentSessionStore(parentSessionManager);
	} catch (error) {
		const message = `Persisted subagent storage is unavailable: ${error instanceof Error ? error.message : String(error)}`;
		reportSubagentRuntimeWarning(parentSessionManager, message);
		for (const child of roster.children) {
			const name = child.kind === "restorable" ? child.snapshot.name : child.name;
			controller.restoreIsolated(name, child.kind === "isolated" ? child.error : message, () =>
				Promise.reject(new Error(message)),
			);
		}
		return;
	}

	for (const child of roster.children) {
		if (child.kind === "isolated") {
			controller.restoreIsolated(child.name, child.error, () =>
				createReplacementSubagentWake(parent, agentDir, store, child.name),
			);
			continue;
		}

		const snapshot = child.snapshot;
		let historyError: string | undefined;
		try {
			store.validateChild(snapshot.name, snapshot.childSessionId, snapshot.childLeafId);
		} catch (error) {
			historyError = `Persisted subagent ${snapshot.name} history is unavailable: ${error instanceof Error ? error.message : String(error)}`;
			reportSubagentRuntimeWarning(parentSessionManager, historyError);
		}
		controller.restore(
			snapshot,
			historyError
				? () => createReplacementSubagentWake(parent, agentDir, store, snapshot.name)
				: () => prepareRestoredSubagentWake(parent, agentDir, store, snapshot),
			historyError,
		);
	}
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/diffex-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	return createInternalAgentSession(options);
}

/** Internal construction lane for controller-owned tools that are never accepted from SDK callers. */
export async function createInternalAgentSession(
	options: CreateAgentSessionOptions = {},
	internalCustomTools: readonly ToolDefinition[] = [],
): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const workspace = await resolveHarnessWorkspace(cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	const loadedHarnessState = options.harnessStateStore
		? { store: options.harnessStateStore, bundle: options.harnessVersionBundle, warning: undefined }
		: await loadWorkspaceHarnessState(agentDir, workspace.workspace);
	const subagentOptions = normalizeSubagentOptions(options.subagents);
	const telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
	assertNoReservedSubagentTools(options.customTools);
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
	const subagentController =
		subagentOptions === false
			? undefined
			: createRootSubagentController(subagentOptions.maxConcurrent, agentDir, telemetryContext, sessionManager);
	const customTools = [
		...(options.customTools ?? []),
		...(subagentController?.createToolDefinitions() ?? []),
		...internalCustomTools,
	];

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write", "update_plan"];
	const allowedToolNames = options.tools
		? [...options.tools, ...internalCustomTools.map((tool) => tool.name)]
		: options.noTools === "all"
			? internalCustomTools.map((tool) => tool.name)
			: undefined;
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
	)
		.filter((name) => !excludedToolNameSet?.has(name))
		.concat(internalCustomTools.map((tool) => tool.name));

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		telemetryContext,
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const headerRunner = extensionRunnerRef.current;
			return modelRuntime.streamSimple(model, context, {
				...options,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				transformHeaders: async (requestHeaders) => {
					const headers = mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						requestHeaders,
					);
					return headerRunner?.hasHandlers("before_provider_headers")
						? headerRunner.emitBeforeProviderHeaders(headers ?? {})
						: (headers ?? {});
				},
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools,
		modelRuntime,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		subagentController,
		harnessStateStore: loadedHarnessState.store,
		harnessVersionBundle: loadedHarnessState.bundle,
		workspaceIdentity: workspace.workspace,
		pinHarnessVersion: options.pinHarnessVersion,
		telemetryContext,
		lifecycleObserver: options.lifecycleObserver,
	});
	if (session.activeHarnessVersion) {
		try {
			await options.lifecycleObserver?.harnessActivated(session.activeHarnessVersion);
		} catch {
			// Lifecycle observers are passive and never change session creation.
		}
	}
	if (subagentController) restoreRootSubagents(subagentController, session, agentDir, sessionManager);
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
		harnessStateWarning: loadedHarnessState.warning,
	};
}
