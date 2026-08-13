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
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { appendEvolvedNote } from "./evolved.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { getHarnessDescriptorsDirectory } from "./harness-descriptors.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import type { ResolvedTaskProfile } from "./profiles.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { DefaultResourceLoader, getProjectContextFileCandidatePaths, type ResourceLoader } from "./resource-loader.ts";
import { startEvolutionSpan } from "./runtime-telemetry.ts";
import { getDefaultSessionDir, SessionManager, type SessionProfileMetadata } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { SubagentController } from "./subagents/controller.ts";
import { captureSubagentSessionConfig, createSubagentSession } from "./subagents/services.ts";
import { RootLocalEphemeralSubagentSessionManagerFactory } from "./subagents/session-manager-factory.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createEvolveToolDefinition,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createUpdatePlanTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import Diffex AI compat itself.
setDefaultStreamFn(streamSimple);

const DEFAULT_SUBAGENT_CONCURRENCY = 4;
const RESERVED_SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "agent_action", "agents"]);

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
	/** Explicit root context for passive runtime telemetry. Defaults to no-op. */
	telemetryContext?: TelemetryContext;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/** Task profile ID/path. Use "auto" for the neutral bootstrap profile. */
	profile?: string;
	/** Whether a host should continue automatic task routing for this session. */
	profileRouting?: "auto" | "pinned";
	/** Generated profiles that must be available before their package path is rediscovered. */
	generatedProfiles?: ResolvedTaskProfile[];
	/** Stable evolved-harness identity used to scope EVOLVED notes. */
	harnessId?: string;

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
	 * When omitted, Diffex enables the active profile's default tools and leaves
	 * extension/custom tools enabled unless `noTools` changes that default.
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
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** Warning if the active task profile denied tools that the caller explicitly requested */
	deniedToolsMessage?: string;
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

function createRootSubagentController(maxConcurrent: number, agentDir: string): SubagentController {
	const sessionManagerFactory = new RootLocalEphemeralSubagentSessionManagerFactory();
	return new SubagentController({
		maxConcurrent,
		captureSession: (parent, childName, origin) => {
			const config = captureSubagentSessionConfig(parent, agentDir);
			return (signal) =>
				createSubagentSession(config, {
					signal,
					childName,
					origin,
					sessionManagerFactory,
				});
		},
	});
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
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	const subagentOptions = normalizeSubagentOptions(options.subagents);
	assertNoReservedSubagentTools(options.customTools);
	const subagentController =
		subagentOptions === false ? undefined : createRootSubagentController(subagentOptions.maxConcurrent, agentDir);
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));
	const telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
	const storedProfile = sessionManager.getHeader()?.profile;
	const harnessId = options.harnessId ?? storedProfile?.harnessId;
	const settingsProfile = settingsManager.getDefaultProfile();
	const selectedProfile = options.profile ?? storedProfile?.source ?? storedProfile?.id ?? settingsProfile;

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			profile: selectedProfile,
			generatedProfiles: options.generatedProfiles,
		});
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}
	const activeProfile = resourceLoader.getActiveProfile();
	const profileRouting =
		options.profileRouting ??
		(options.profile !== undefined
			? options.profile === "auto"
				? "auto"
				: "pinned"
			: (storedProfile?.routing ??
				(settingsProfile === undefined || settingsProfile === "auto" ? "auto" : "pinned")));
	const profileMetadata: SessionProfileMetadata = {
		id: activeProfile.id,
		hash: activeProfile.hash,
		...(activeProfile.origin === "builtin" ? {} : { source: activeProfile.source.path }),
		routing: profileRouting,
		...(harnessId
			? {
					harnessId,
					...(storedProfile?.harnessId === harnessId && storedProfile.harnessRevision
						? { harnessRevision: storedProfile.harnessRevision }
						: {}),
				}
			: {}),
	};
	if (
		storedProfile?.id !== profileMetadata.id ||
		storedProfile.hash !== profileMetadata.hash ||
		storedProfile.source !== profileMetadata.source ||
		storedProfile.routing !== profileMetadata.routing ||
		storedProfile.harnessId !== profileMetadata.harnessId ||
		storedProfile.harnessRevision !== profileMetadata.harnessRevision
	) {
		sessionManager.setProfileMetadata(profileMetadata);
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

	const defaultActiveToolNames = activeProfile.tools.default;
	const profileRequiredToolNames = activeProfile.tools.required;
	const allowedToolNames = options.tools
		? [...new Set([...options.tools, ...profileRequiredToolNames])]
		: options.noTools === "all"
			? []
			: undefined;
	const excludedToolNames = options.excludeTools;
	// A profile's denied list is a ceiling, not a default: a high-stakes profile must not gain a tool
	// just because a caller asked for it. Requested-but-denied tools are reported rather than dropped
	// silently, so `--tools read,bash` under a bash-denying profile is not a mystery.
	const profileDeniedToolNames = activeProfile.tools.denied;
	const excludedBuiltinToolNameSet = new Set(profileDeniedToolNames);
	const deniedRequestedToolNames = (options.tools ?? []).filter((name) => excludedBuiltinToolNameSet.has(name));
	const deniedToolsMessage =
		deniedRequestedToolNames.length > 0
			? `Task profile "${activeProfile.id}" denies ${deniedRequestedToolNames.join(", ")}. ${
					deniedRequestedToolNames.length === 1 ? "That tool was" : "Those tools were"
				} not enabled. Pin a profile that allows it with --profile.`
			: undefined;
	const initialActiveToolNames: string[] = (
		options.tools
			? [...new Set([...options.tools, ...profileRequiredToolNames])]
			: options.noTools
				? []
				: [...new Set([...defaultActiveToolNames, ...profileRequiredToolNames])]
	).filter((name) => !excludedBuiltinToolNameSet.has(name) && !excludedToolNames?.includes(name));
	const shouldRegisterEvolve =
		(options.tools === undefined && options.noTools === undefined) ||
		options.tools?.includes("evolve") === true ||
		(options.tools !== undefined && profileRequiredToolNames.includes("evolve"));
	const evolveToolDefinition = shouldRegisterEvolve
		? createEvolveToolDefinition({
				appendNote: async (input) => {
					return startEvolutionSpan(
						telemetryContext,
						{
							sessionId: sessionManager.getSessionId(),
							trigger: "explicit",
							profileId: harnessId ?? activeProfile.id,
						},
						({ complete }) => {
							try {
								const note = appendEvolvedNote({
									agentDir,
									cwd,
									projectTrusted: settingsManager.isProjectTrusted(),
									scope: input.scope,
									profileId: input.appliesTo === "user" ? "*" : (harnessId ?? activeProfile.id),
									category: input.category,
									provenance: `session:${sessionManager.getSessionId()}`,
									content: input.evidence ? `${input.note}\n\nEvidence: ${input.evidence}` : input.note,
								});
								complete({
									outcome: "completed",
									candidateCount: 1,
									acceptedCount: 1,
									rejectedCount: 0,
									scope: input.scope,
								});
								return { path: note.sourcePath };
							} catch (error) {
								complete({
									outcome: "failed",
									candidateCount: 1,
									acceptedCount: 0,
									rejectedCount: 1,
									scope: input.scope,
								});
								throw error;
							}
						},
					);
				},
			})
		: undefined;
	const customTools = [
		...(options.customTools ?? []).filter((tool) => tool.name !== "evolve"),
		...(evolveToolDefinition ? [evolveToolDefinition] : []),
		...(subagentController?.createToolDefinitions() ?? []),
	];

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
		telemetryContext,
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
		harnessId,
		customTools,
		modelRuntime,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		excludedBuiltinToolNames: profileDeniedToolNames,
		selfEvolutionProtectedPaths: [
			join(agentDir, "EVOLVED.md"),
			...getProjectContextFileCandidatePaths({ cwd, agentDir }),
		],
		selfEvolutionProtectedRoots: [
			join(agentDir, "profiles"),
			join(cwd, CONFIG_DIR_NAME, "profiles"),
			getHarnessDescriptorsDirectory(agentDir),
		],
		selfEvolutionQuarantineDir: join(agentDir, "quarantine", "self-evolution"),
		selfEvolutionEvolvedPaths: {
			globalPath: join(agentDir, "EVOLVED.md"),
			...(settingsManager.isProjectTrusted() ? { projectPath: join(cwd, CONFIG_DIR_NAME, "EVOLVED.md") } : {}),
		},
		selfEvolutionEvolveTool: evolveToolDefinition,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		subagentController,
	});
	subagentController?.bindParent(session);
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
		deniedToolsMessage,
	};
}
