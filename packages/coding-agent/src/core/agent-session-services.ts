import { join } from "node:path";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext, type ThinkingLevel } from "@diffexai/diffex-agent-core";
import type { Model } from "@diffexai/diffex-ai";
import type { HarnessStateStore, HarnessVersionBundle } from "@diffexai/diffex-harness-state";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSessionLifecycleObserver } from "./agent-session-lifecycle.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { loadWorkspaceHarnessState, resolveHarnessWorkspace } from "./harness-state-runtime.ts";
import { ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createInternalAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { registerSubagentRuntimeDiagnosticSink } from "./subagents/runtime-diagnostics.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	settingsManager?: SettingsManager;
	modelRuntime?: ModelRuntime;
	modelRuntimeSignal?: AbortSignal;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
	harnessStateStore?: HarnessStateStore;
	harnessVersionBundle?: HarnessVersionBundle;
	telemetryContext?: TelemetryContext;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	backgroundProcessPolicy?: CreateAgentSessionOptions["backgroundProcessPolicy"];
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	subagents?: CreateAgentSessionOptions["subagents"];
	lifecycleObserver?: AgentSessionLifecycleObserver;
	pinHarnessVersion?: boolean;
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	harnessStateStore: HarnessStateStore;
	harnessVersionBundle: HarnessVersionBundle | undefined;
	telemetryContext: TelemetryContext;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			signal: options.modelRuntimeSignal,
		}));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const harnessState = options.harnessStateStore
		? { store: options.harnessStateStore, bundle: options.harnessVersionBundle, warning: undefined }
		: await loadWorkspaceHarnessState(agentDir, (await resolveHarnessWorkspace(cwd)).workspace);
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	if (harnessState.warning) {
		diagnostics.push({ type: "warning", message: harnessState.warning });
	}
	const extensionsResult = resourceLoader.getExtensions();
	let registeredProvider = false;
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
			registeredProvider = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	for (const { provider, extensionPath } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
			registeredProvider = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingNativeProviderRegistrations = [];
	if (registeredProvider) {
		await modelRuntime.refresh({ allowNetwork: false });
	}
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		harnessStateStore: harnessState.store,
		harnessVersionBundle: harnessState.bundle,
		telemetryContext: options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT,
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createInternalAgentSessionFromServices(options);
}

/** Internal construction lane for controller-owned tools. */
export async function createInternalAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
	internalCustomTools: readonly ToolDefinition[] = [],
): Promise<CreateAgentSessionResult> {
	registerSubagentRuntimeDiagnosticSink(options.sessionManager, options.services.diagnostics);
	const result = await createInternalAgentSession(
		{
			backgroundProcessPolicy: options.backgroundProcessPolicy,
			cwd: options.services.cwd,
			agentDir: options.services.agentDir,
			modelRuntime: options.services.modelRuntime,
			settingsManager: options.services.settingsManager,
			resourceLoader: options.services.resourceLoader,
			harnessStateStore: options.services.harnessStateStore,
			harnessVersionBundle: options.services.harnessVersionBundle,
			pinHarnessVersion: options.pinHarnessVersion,
			telemetryContext: options.services.telemetryContext,
			sessionManager: options.sessionManager,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			scopedModels: options.scopedModels,
			tools: options.tools,
			excludeTools: options.excludeTools,
			noTools: options.noTools,
			customTools: options.customTools,
			subagents: options.subagents,
			lifecycleObserver: options.lifecycleObserver,
			sessionStartEvent: options.sessionStartEvent,
		},
		internalCustomTools,
	);
	if (result.harnessStateWarning) {
		options.services.diagnostics.push({ type: "warning", message: result.harnessStateWarning });
	}
	return result;
}
