/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
export {
	type AppendEvolvedNoteOptions,
	appendEvolvedNote,
	type CreateGeneratedProfileOptions,
	createGeneratedProfile,
	type EvolvedDiagnostic,
	type EvolvedLocationOptions,
	type EvolvedNote,
	type EvolvedPaths,
	type FinalizeGeneratedProfileOptions,
	finalizeGeneratedProfile,
	initializeEvolvedFiles,
	type LoadEvolvedNotesOptions,
	type LoadEvolvedNotesResult,
	loadEvolvedNotes,
} from "./evolved.ts";
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentSettledEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export {
	buildProfileRouterPrompt,
	PROFILE_ROUTE_CONFIDENCE_THRESHOLD,
	type ProfileRouteAction,
	type ProfileRouteDecision,
	type ProfileRouteInput,
	type ProfileRouterCompletion,
	parseProfileRouteDecision,
	routeTaskProfile,
} from "./profile-router.ts";
export {
	BOOTSTRAP_TASK_PROFILE_ID,
	BUILTIN_TASK_PROFILES,
	computeTaskProfileHash,
	DEFAULT_TASK_PROFILE_ID,
	loadTaskProfiles,
	type ResolvedTaskProfile,
	type ResolveTaskProfileManifestOptions,
	type ResolveTaskProfileManifestResult,
	type ResolveTaskProfileSelectionOptions,
	type ResolveTaskProfileSelectionResult,
	resolveTaskProfileManifest,
	resolveTaskProfileSelection,
	type TaskProfile,
	type TaskProfileCollision,
	type TaskProfileContext,
	type TaskProfileDiagnostic,
	type TaskProfileGuardrails,
	type TaskProfileLoadInput,
	type TaskProfileLoadResult,
	type TaskProfileManifest,
	type TaskProfileOrigin,
	TaskProfileRegistry,
	type TaskProfileRouting,
	type TaskProfileSource,
	type TaskProfileToolPolicy,
} from "./profiles.ts";
export {
	findSelfEvolutionPolicyViolation,
	type SelfEvolutionPolicyViolation,
	type SelfEvolutionProtectionOptions,
} from "./self-evolution-policy.ts";
export type { SessionProfileMetadata } from "./session-manager.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
