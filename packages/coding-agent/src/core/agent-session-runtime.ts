import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/diffex-agent-core";
import type { Api, Model } from "@earendil-works/diffex-ai";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession, PromptOptions } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import { loadEvolvedNotes } from "./evolved.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import {
	createHarnessDescriptor,
	loadHarnessDescriptors,
	type ResolvedHarnessDescriptor,
} from "./harness-descriptors.ts";
import { routeTaskBoundary, routeTaskProfile, shouldEvaluateTaskBoundary } from "./profile-router.ts";
import type { ResolvedTaskProfile } from "./profiles.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
import { startProfileRouteSpan, traceAiCompletion } from "./runtime-telemetry.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export type ProfileRoutingMode = "auto" | "pinned";

/** Resolve CLI/runtime profile precedence without treating the `auto` sentinel as a pinned profile. */
export function resolveProfileRoutingMode(
	selectedProfile: string | undefined,
	requestedMode: ProfileRoutingMode | undefined,
	settingsDefaultProfile: string | undefined,
): ProfileRoutingMode {
	if (selectedProfile?.trim() === "auto") return "auto";
	if (requestedMode) return requestedMode;
	if (selectedProfile?.trim()) return "pinned";
	const normalizedDefault = settingsDefaultProfile?.trim();
	return normalizedDefault && normalizedDefault !== "auto" ? "pinned" : "auto";
}

export interface RuntimePromptResult {
	routing: "bypassed" | "selected" | "reused" | "failed";
	activeProfileId: string;
	previousProfileId?: string;
	harnessId?: string;
	harnessRevision?: string;
	notice?: string;
	reason?: string;
}

export interface ProfileSwitchEvent {
	fromProfileId: string;
	toProfileId: string;
	reason: string;
	harnessId: string;
	harnessRevision: string;
	harnessName: string;
	reused: boolean;
	notice: string;
}

/** Content-free task-boundary proposal presented by a host before a future prompt is delivered. */
export interface TaskBoundaryProposal {
	decision: "reuse" | "select";
	fromProfileId: string;
	fromHarnessId: string;
	toProfileId: string;
	targetHarnessId?: string;
	targetHarnessRevision?: string;
	targetHarnessName: string;
	confidence: number;
}

export type TaskBoundaryResolution = "switch" | "stay" | "cancel";
export type TaskBoundaryResolver = (proposal: TaskBoundaryProposal) => Promise<TaskBoundaryResolution>;

export class TaskBoundaryCancelledError extends Error {
	constructor(message = "Task boundary switch cancelled") {
		super(message);
		this.name = "TaskBoundaryCancelledError";
	}
}

interface PreparedRuntimePrompt {
	result: RuntimePromptResult;
	completion: Promise<void>;
	accepted: boolean;
	cancelledError?: TaskBoundaryCancelledError;
	resolution?: {
		prompt: string;
		messageCountBefore: number;
	};
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	profile?: string;
	profileRouting?: ProfileRoutingMode;
	harnessId?: string;
	telemetryContext?: AgentSessionServices["telemetryContext"];
	telemetryCapture?: AgentSessionServices["telemetryCapture"];
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

const ROUTING_CONTEXT_MAX_CHARS = 6_000;
const ROUTING_TIMEOUT_MS = 15_000;
const BUILTIN_SLASH_COMMAND_NAMES = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
const ROUTE_FALLBACK_TELEMETRY = {
	"completion-error": "completion_error",
	"invalid-output": "invalid_output",
	"low-confidence": "low_confidence",
} as const;

/**
 * Expand public skill/template resources for classification only.
 *
 * The original prompt is still delivered to AgentSession, so extension input
 * hooks and canonical expansion execute exactly once. Extension and built-in
 * commands retain precedence over colliding resources.
 */
export function resolvePromptForProfileRouting(session: AgentSession, text: string): string | undefined {
	if (!text.startsWith("/")) return text;
	const commandMatch = text.match(/^\/([^\s]+)(?:\s|$)/);
	const commandName = commandMatch?.[1];
	if (!commandName) return undefined;
	if (BUILTIN_SLASH_COMMAND_NAMES.has(commandName) || session.extensionRunner.getCommand(commandName)) {
		return undefined;
	}

	if (commandName.startsWith("skill:")) {
		const skillName = commandName.slice("skill:".length);
		const skill = session.resourceLoader.getSkills().skills.find((candidate) => candidate.name === skillName);
		if (!skill) return undefined;
		try {
			const args = text.slice(commandMatch[0].length).trim();
			const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
			const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${block}\n\n${args}` : block;
		} catch {
			return undefined;
		}
	}

	const expanded = expandPromptTemplate(text, [...session.promptTemplates]);
	return expanded === text ? undefined : expanded;
}

function extractRoutingMessageText(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") {
		return undefined;
	}
	const content = message.content;
	if (typeof content === "string") {
		return content.trim() || undefined;
	}
	const text = content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

/** Build a bounded router excerpt that excludes custom messages and tool output. */
export function buildRecentTaskContext(messages: readonly AgentMessage[]): string {
	const excerpts: string[] = [];
	let remaining = ROUTING_CONTEXT_MAX_CHARS;
	for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
		const message = messages[index];
		if (!message) continue;
		const text = extractRoutingMessageText(message);
		if (!text) continue;
		const label = message.role === "user" ? "User" : "Assistant";
		const prefix = `${label}: `;
		const available = Math.max(0, remaining - prefix.length);
		if (available === 0) break;
		const excerpt = text.length > available ? text.slice(text.length - available) : text;
		excerpts.unshift(`${prefix}${excerpt}`);
		remaining -= prefix.length + excerpt.length;
	}
	return excerpts.join("\n\n");
}

function getProfileSelection(sessionManager: SessionManager): {
	profile?: string;
	profileRouting?: ProfileRoutingMode;
	harnessId?: string;
	harnessRevision?: string;
} {
	const metadata = sessionManager.getHeader()?.profile;
	if (!metadata) return {};
	return {
		profile: metadata.source ?? metadata.id,
		profileRouting: metadata.routing,
		harnessId: metadata.harnessId,
		harnessRevision: metadata.harnessRevision,
	};
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods preserve task-profile state across runtime
 * changes. Errors are propagated to the caller for user-facing handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private profileSwitchListener?: (event: ProfileSwitchEvent) => void;
	private taskBoundaryResolver?: TaskBoundaryResolver;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private replacementDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
	private _modelFallbackMessage?: string;
	private disposePromise: Promise<void> | undefined;
	private _profileRouting: ProfileRoutingMode;
	private _activeHarness?: ResolvedHarnessDescriptor;
	private harnessResolutionClaimed = false;
	private harnessResolutionGate?: Promise<void>;
	private settleHarnessResolutionGate?: () => void;
	private promptPreparationQueue: Promise<void> = Promise.resolve();

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		profileRouting?: ProfileRoutingMode,
		harnessId?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this._profileRouting = profileRouting ?? _session.sessionManager.getHeader()?.profile?.routing ?? "auto";
		this.restoreHarness(harnessId ?? _session.sessionManager.getHeader()?.profile?.harnessId);
		this.syncProfileMetadata();
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	get activeProfile(): ResolvedTaskProfile {
		return this.services.resourceLoader.getActiveProfile();
	}

	get profileRouting(): ProfileRoutingMode {
		return this._profileRouting;
	}

	get activeHarness(): ResolvedHarnessDescriptor | undefined {
		return this._activeHarness;
	}

	setProfileRouting(mode: ProfileRoutingMode): void {
		this._profileRouting = mode;
		this.syncProfileMetadata();
	}

	private getCurrentProfileSelection(): string {
		const profile = this.activeProfile;
		return profile.origin === "builtin" ? profile.id : profile.source.path;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	setProfileSwitchListener(listener?: (event: ProfileSwitchEvent) => void): void {
		this.profileSwitchListener = listener;
	}

	setTaskBoundaryResolver(resolver?: TaskBoundaryResolver): void {
		this.taskBoundaryResolver = resolver;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private appendDiagnostic(message: string, carryAcrossReplacement = false): void {
		const diagnostic: AgentSessionRuntimeDiagnostic = { type: "warning", message };
		this._diagnostics = [...this._diagnostics, diagnostic];
		if (carryAcrossReplacement) {
			this.replacementDiagnostics.push(diagnostic);
		}
	}

	private syncProfileMetadata(profile = this.activeProfile): void {
		this.session.sessionManager.setProfileMetadata({
			id: profile.id,
			hash: profile.hash,
			...(profile.origin === "builtin" ? {} : { source: profile.source.path }),
			routing: this._profileRouting,
			...(this._activeHarness
				? { harnessId: this._activeHarness.id, harnessRevision: this._activeHarness.revision }
				: {}),
		});
	}

	private restoreHarness(harnessId: string | undefined): void {
		this._activeHarness = undefined;
		if (!harnessId) return;
		const loaded = loadHarnessDescriptors({
			agentDir: this.services.agentDir,
			notes: this.services.resourceLoader.getEvolvedNotes().evolvedNotes,
		});
		for (const diagnostic of loaded.diagnostics) {
			this.appendDiagnostic(`Could not load harness descriptor ${diagnostic.path}: ${diagnostic.message}`);
		}
		const harness = loaded.harnesses.find((candidate) => candidate.id === harnessId);
		if (!harness) {
			this.appendDiagnostic(
				`Could not restore harness "${harnessId}"; this session will use one-time routing again.`,
			);
			return;
		}
		if (this.activeProfile.id !== harness.baseProfileId) {
			this.appendDiagnostic(
				`Could not restore harness "${harnessId}" because its base profile "${harness.baseProfileId}" does not match active profile "${this.activeProfile.id}"; this session will use one-time routing again.`,
			);
			return;
		}
		this._activeHarness = harness;
	}

	private getSessionProfileSelection(sessionManager: SessionManager): ReturnType<typeof getProfileSelection> {
		const selection = getProfileSelection(sessionManager);
		if (!selection.harnessId) return selection;
		const loaded = loadHarnessDescriptors({ agentDir: this.services.agentDir });
		for (const diagnostic of loaded.diagnostics) {
			this.appendDiagnostic(`Could not load harness descriptor ${diagnostic.path}: ${diagnostic.message}`);
		}
		const harness = loaded.harnesses.find((candidate) => candidate.id === selection.harnessId);
		if (harness) return { ...selection, profile: harness.baseProfileId };
		this.appendDiagnostic(
			`Could not restore harness "${selection.harnessId}"; ${selection.profileRouting === "auto" ? "falling back to DEFAULT" : "keeping the pinned profile"}.`,
		);
		return {
			profile: selection.profileRouting === "auto" ? "general" : selection.profile,
			profileRouting: selection.profileRouting,
		};
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		const session = this.session;
		const failures: unknown[] = [];
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		try {
			await session.abort();
		} catch (error) {
			failures.push(error);
		}
		try {
			await emitSessionShutdownEvent(session.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionFile,
			});
		} catch (error) {
			failures.push(error);
		}
		try {
			this.beforeSessionInvalidate?.();
		} catch (error) {
			failures.push(error);
		}
		try {
			await session.dispose();
		} catch (error) {
			if (error instanceof AggregateError) {
				failures.push(...error.errors);
			} else {
				failures.push(error);
			}
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, `Failed to tear down agent session for ${reason}`);
		}
	}

	private apply(
		result: CreateAgentSessionRuntimeResult,
		profileRouting?: ProfileRoutingMode,
		harnessId?: string,
	): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = [...result.diagnostics, ...this.replacementDiagnostics];
		if (result.deniedToolsMessage) {
			this._diagnostics.push({ type: "warning", message: result.deniedToolsMessage });
		}
		this.replacementDiagnostics = [];
		this._modelFallbackMessage = result.modelFallbackMessage;
		this._profileRouting = result.session.sessionManager.getHeader()?.profile?.routing ?? profileRouting ?? "auto";
		this.restoreHarness(harnessId ?? result.session.sessionManager.getHeader()?.profile?.harnessId);
		this.harnessResolutionClaimed = this._activeHarness !== undefined;
		this.syncProfileMetadata();
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		const profileSelection = this.getSessionProfileSelection(sessionManager);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				profile: profileSelection.profile,
				profileRouting: profileSelection.profileRouting,
				harnessId: profileSelection.harnessId,
				telemetryContext: this.services.telemetryContext,
				telemetryCapture: this.services.telemetryCapture,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
			profileSelection.profileRouting,
			profileSelection.harnessId,
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		profile?: string;
		profileRouting?: ProfileRoutingMode;
		harnessId?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		const targetRouting = options?.profileRouting ?? this._profileRouting;
		const targetHarness = options?.harnessId
			? loadHarnessDescriptors({ agentDir: this.services.agentDir }).harnesses.find(
					(harness) => harness.id === options.harnessId,
				)
			: undefined;
		const targetHarnessId = targetHarness?.id;
		const targetProfile =
			targetHarness?.baseProfileId ??
			(targetRouting === "auto" ? "general" : (options?.profile ?? this.getCurrentProfileSelection()));
		const nextRuntime = await this.createRuntime({
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			profile: targetProfile,
			profileRouting: targetRouting,
			harnessId: targetHarnessId,
			telemetryContext: this.services.telemetryContext,
			telemetryCapture: this.services.telemetryCapture,
			sessionStartEvent: {
				type: "session_start",
				reason: "new",
				previousSessionFile,
			},
		});
		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(nextRuntime, targetRouting, targetHarnessId);
		let contextChanged = false;
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			contextChanged = true;
		}
		if (contextChanged) {
			this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				const targetRouting = this._profileRouting;
				const targetProfile = this.getCurrentProfileSelection();
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						profile: targetProfile,
						profileRouting: targetRouting,
						harnessId: this._activeHarness?.id,
						telemetryContext: this.services.telemetryContext,
						telemetryCapture: this.services.telemetryCapture,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
					targetRouting,
					this._activeHarness?.id,
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			const profileSelection = this.getSessionProfileSelection(sessionManager);
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					profile: profileSelection.profile,
					profileRouting: profileSelection.profileRouting,
					harnessId: profileSelection.harnessId,
					telemetryContext: this.services.telemetryContext,
					telemetryCapture: this.services.telemetryCapture,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
				profileSelection.profileRouting,
				profileSelection.harnessId,
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		const targetRouting = this._profileRouting;
		const targetProfile = this.getCurrentProfileSelection();
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				profile: targetProfile,
				profileRouting: targetRouting,
				harnessId: this._activeHarness?.id,
				telemetryContext: this.services.telemetryContext,
				telemetryCapture: this.services.telemetryCapture,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
			targetRouting,
			this._activeHarness?.id,
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		const profileSelection = this.getSessionProfileSelection(sessionManager);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				profile: profileSelection.profile,
				profileRouting: profileSelection.profileRouting,
				harnessId: profileSelection.harnessId,
				telemetryContext: this.services.telemetryContext,
				telemetryCapture: this.services.telemetryCapture,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
			profileSelection.profileRouting,
			profileSelection.harnessId,
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	/** Use the active model unless the user explicitly configures a dedicated router model. */
	private resolveProfileRouterModel(sessionModel: Model<Api>): Model<Api> {
		const configured = this.services.settingsManager.getRouterModel();
		if (configured) {
			const [provider, ...rest] = configured.split("/");
			const id = rest.join("/") || provider;
			const match = this.session.modelRuntime
				.getModels(rest.length > 0 ? provider : undefined)
				.find((candidate) => candidate.id === id);
			if (match) return match;
		}
		return sessionModel;
	}

	private async completeProfileRoute(
		routerPrompt: string,
		telemetryContext: AgentSessionServices["telemetryContext"],
	): Promise<string> {
		const sessionModel = this.session.model;
		if (!sessionModel) {
			throw new Error("No model is selected for task profile routing");
		}
		const model = this.resolveProfileRouterModel(sessionModel);
		const response = await traceAiCompletion(telemetryContext, model, (childContext) =>
			this.session.modelRuntime.completeSimple(
				model,
				{
					systemPrompt: "Route the task using the requested JSON schema. Return JSON only.",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: routerPrompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: 1_200,
					cacheRetention: "none",
					sessionId: randomUUID(),
					signal: AbortSignal.timeout(ROUTING_TIMEOUT_MS),
					telemetryContext: childContext,
				},
			),
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? `Profile router request ${response.stopReason}`);
		}
		const output = response.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (!output) {
			throw new Error("Profile router returned no text");
		}
		return output;
	}

	private enqueuePromptPreparation(operation: () => Promise<PreparedRuntimePrompt>): Promise<PreparedRuntimePrompt> {
		const queued = this.promptPreparationQueue.then(operation, operation);
		this.promptPreparationQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	private async startSessionPrompt(
		text: string,
		options: PromptOptions | undefined,
		result: RuntimePromptResult,
	): Promise<PreparedRuntimePrompt> {
		let settlePreflight: ((success: boolean) => void) | undefined;
		const preflight = new Promise<boolean>((resolvePreflight) => {
			settlePreflight = resolvePreflight;
		});
		let preflightSettled = false;
		const settle = (success: boolean) => {
			if (preflightSettled) return;
			preflightSettled = true;
			settlePreflight?.(success);
		};
		const completion = this.session.prompt(text, {
			...options,
			preflightResult: (success) => {
				try {
					options?.preflightResult?.(success);
				} finally {
					settle(success);
				}
			},
		});
		void completion.then(
			() => settle(true),
			() => settle(false),
		);
		const accepted = await preflight;
		return { result, completion, accepted };
	}

	private cancelPreparedPrompt(options: PromptOptions | undefined, message?: string): PreparedRuntimePrompt {
		options?.preflightResult?.(false);
		return {
			result: {
				routing: "failed",
				activeProfileId: this.activeProfile.id,
				...(this._activeHarness
					? { harnessId: this._activeHarness.id, harnessRevision: this._activeHarness.revision }
					: {}),
			},
			completion: Promise.resolve(),
			accepted: false,
			cancelledError: new TaskBoundaryCancelledError(message),
		};
	}

	private async startLinkedHarnessSession(
		harness: ResolvedHarnessDescriptor,
		profile: ResolvedTaskProfile,
	): Promise<void> {
		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir, { parentSession: previousSessionFile })
			: SessionManager.inMemory(this.cwd, { parentSession: previousSessionFile });
		const nextRuntime = await this.createRuntime({
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			profile: profile.id,
			profileRouting: "auto",
			harnessId: harness.id,
			telemetryContext: this.services.telemetryContext,
			telemetryCapture: this.services.telemetryCapture,
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
		});
		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(nextRuntime, "auto", harness.id);
		await this.finishSessionReplacement();
	}

	private async prepareFutureTaskPrompt(
		text: string,
		routingPrompt: string,
		options: PromptOptions | undefined,
	): Promise<PreparedRuntimePrompt> {
		const resolver = this.taskBoundaryResolver;
		const currentHarness = this._activeHarness;
		const currentProfile = this.activeProfile;
		if (!resolver || !currentHarness) {
			return this.startSessionPrompt(text, options, {
				routing: "bypassed",
				activeProfileId: currentProfile.id,
				harnessId: currentHarness?.id,
				harnessRevision: currentHarness?.revision,
			});
		}
		if (text.trim().length === 0) {
			return this.startSessionPrompt(text, options, {
				routing: "bypassed",
				activeProfileId: currentProfile.id,
				harnessId: currentHarness.id,
				harnessRevision: currentHarness.revision,
			});
		}

		const profiles = this.services.resourceLoader
			.getProfiles()
			.profiles.filter((profile) => profile.origin === "builtin" && profile.immutable);
		const loadedHarnesses = loadHarnessDescriptors({
			agentDir: this.services.agentDir,
			notes: this.services.resourceLoader.getEvolvedNotes().evolvedNotes,
		});
		for (const diagnostic of loadedHarnesses.diagnostics) {
			this.appendDiagnostic(`Could not load harness descriptor ${diagnostic.path}: ${diagnostic.message}`);
		}
		const reusableHarnesses = loadedHarnesses.harnesses.filter(
			(harness) =>
				harness.id !== currentHarness.id &&
				harness.harnessNoteCount > 0 &&
				profiles.some((profile) => profile.id === harness.baseProfileId),
		);
		const input = {
			prompt: routingPrompt,
			recentTaskContext: buildRecentTaskContext(this.session.messages),
			candidates: profiles,
			harnesses: reusableHarnesses,
			currentProfile,
			currentHarness,
		};
		if (!shouldEvaluateTaskBoundary(input)) {
			return this.startSessionPrompt(text, options, {
				routing: "bypassed",
				activeProfileId: currentProfile.id,
				harnessId: currentHarness.id,
				harnessRevision: currentHarness.revision,
			});
		}

		const startingSession = this.session;
		return startProfileRouteSpan(
			this.services.telemetryContext,
			{
				sessionId: this.session.sessionManager.getSessionId(),
				routingMode: this._profileRouting,
				trigger: "future_turn",
				currentProfileId: currentProfile.id,
				currentHarnessId: currentHarness.id,
				sessionEstablished: true,
			},
			async ({ context: routeContext, complete }) => {
				const decision = await routeTaskBoundary(input, (routerPrompt) =>
					this.completeProfileRoute(routerPrompt, routeContext),
				);
				if (this.session !== startingSession || this._activeHarness?.id !== currentHarness.id) {
					complete({ outcome: "failed", targetProfileId: currentProfile.id, harnessId: currentHarness.id });
					return this.cancelPreparedPrompt(options, "Session changed while task boundary routing was pending");
				}
				if (decision.fallback) {
					const detail = decision.fallbackDetail ? `: ${decision.fallbackDetail}` : "";
					this.appendDiagnostic(`Task boundary router used ${decision.fallback} fallback${detail}`, true);
				}
				if (decision.decision === "stay") {
					complete({
						outcome: "stayed",
						targetProfileId: currentProfile.id,
						harnessId: currentHarness.id,
						confidence: decision.confidence,
						...(decision.fallback ? { fallback: ROUTE_FALLBACK_TELEMETRY[decision.fallback] } : {}),
					});
					return this.startSessionPrompt(text, options, {
						routing: "bypassed",
						activeProfileId: currentProfile.id,
						harnessId: currentHarness.id,
						harnessRevision: currentHarness.revision,
					});
				}

				const targetHarness =
					decision.decision === "reuse"
						? reusableHarnesses.find((harness) => harness.id === decision.harnessId)
						: undefined;
				const targetProfile = profiles.find(
					(profile) => profile.id === (targetHarness?.baseProfileId ?? decision.profileId),
				);
				if (!targetProfile || (decision.decision === "reuse" && !targetHarness)) {
					complete({ outcome: "failed", targetProfileId: currentProfile.id, harnessId: currentHarness.id });
					return this.cancelPreparedPrompt(options, "Task boundary target is no longer available");
				}
				const proposal: TaskBoundaryProposal = {
					decision: decision.decision,
					fromProfileId: currentProfile.id,
					fromHarnessId: currentHarness.id,
					toProfileId: targetProfile.id,
					targetHarnessName: targetHarness?.name ?? decision.harnessName ?? "New task",
					confidence: decision.confidence,
					...(targetHarness
						? { targetHarnessId: targetHarness.id, targetHarnessRevision: targetHarness.revision }
						: {}),
				};
				let resolution: TaskBoundaryResolution;
				try {
					resolution = await resolver(proposal);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.appendDiagnostic(`Task boundary confirmation failed: ${message}`);
					complete({ outcome: "failed", targetProfileId: currentProfile.id, harnessId: currentHarness.id });
					return this.cancelPreparedPrompt(options, `Task boundary confirmation failed: ${message}`);
				}
				if (this.session !== startingSession || this._activeHarness?.id !== currentHarness.id) {
					complete({ outcome: "failed", targetProfileId: currentProfile.id, harnessId: currentHarness.id });
					return this.cancelPreparedPrompt(
						options,
						"Session changed while task boundary confirmation was pending",
					);
				}
				if (resolution === "stay") {
					complete({
						outcome: "declined",
						targetProfileId: currentProfile.id,
						harnessId: currentHarness.id,
						confidence: decision.confidence,
					});
					return this.startSessionPrompt(text, options, {
						routing: "bypassed",
						activeProfileId: currentProfile.id,
						harnessId: currentHarness.id,
						harnessRevision: currentHarness.revision,
					});
				}
				if (resolution !== "switch") {
					complete({
						outcome: "declined",
						targetProfileId: currentProfile.id,
						harnessId: currentHarness.id,
						confidence: decision.confidence,
					});
					return this.cancelPreparedPrompt(options);
				}

				let validatedTargetHarness = targetHarness;
				if (targetHarness) {
					const currentNotes = loadEvolvedNotes({
						agentDir: this.services.agentDir,
						cwd: this.cwd,
						projectTrusted: this.services.settingsManager.isProjectTrusted(),
					});
					for (const diagnostic of currentNotes.diagnostics) {
						this.appendDiagnostic(`Could not refresh evolved notes ${diagnostic.path}: ${diagnostic.message}`);
					}
					const refreshedHarnesses = loadHarnessDescriptors({
						agentDir: this.services.agentDir,
						notes: currentNotes.notes,
					});
					for (const diagnostic of refreshedHarnesses.diagnostics) {
						this.appendDiagnostic(
							`Could not refresh harness descriptor ${diagnostic.path}: ${diagnostic.message}`,
						);
					}
					validatedTargetHarness = refreshedHarnesses.harnesses.find((harness) => harness.id === targetHarness.id);
					if (
						!validatedTargetHarness ||
						validatedTargetHarness.baseProfileId !== targetHarness.baseProfileId ||
						validatedTargetHarness.revision !== targetHarness.revision
					) {
						complete({ outcome: "failed", targetProfileId: currentProfile.id, harnessId: currentHarness.id });
						return this.cancelPreparedPrompt(
							options,
							"The selected evolved harness changed while confirmation was pending",
						);
					}
				}

				let harness: ResolvedHarnessDescriptor;
				try {
					const beforeResult = await this.emitBeforeSwitch("new");
					if (beforeResult.cancelled) {
						complete({ outcome: "failed", targetProfileId: currentProfile.id, harnessId: currentHarness.id });
						return this.cancelPreparedPrompt(options, "Task boundary switch was blocked by a session hook");
					}
					harness =
						validatedTargetHarness ??
						createHarnessDescriptor({
							agentDir: this.services.agentDir,
							name: decision.harnessName ?? "New task",
							description: decision.harnessDescription ?? "Harness for a new task.",
							baseProfileId: targetProfile.id,
							notes: this.services.resourceLoader.getEvolvedNotes().evolvedNotes,
						});
					await this.startLinkedHarnessSession(harness, targetProfile);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					complete({ outcome: "failed", targetProfileId: currentProfile.id, harnessId: currentHarness.id });
					return this.cancelPreparedPrompt(options, `Task boundary switch failed: ${message}`);
				}

				const reused = decision.decision === "reuse";
				const notice = reused
					? `Found evolved harness "${harness.name}" for this task. Switched to revision ${harness.revision.slice(0, 12)}.`
					: `Created harness "${harness.name}" using the ${targetProfile.name} prompt profile.`;
				try {
					this.profileSwitchListener?.({
						fromProfileId: currentProfile.id,
						toProfileId: targetProfile.id,
						reason: decision.reason,
						harnessId: harness.id,
						harnessRevision: harness.revision,
						harnessName: harness.name,
						reused,
						notice,
					});
				} catch (error) {
					this.appendDiagnostic(
						`Task profile switch listener failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				complete({
					outcome: reused ? "reused" : "selected",
					targetProfileId: targetProfile.id,
					harnessId: harness.id,
					confidence: decision.confidence,
				});
				return this.startSessionPrompt(text, options, {
					routing: reused ? "reused" : "selected",
					activeProfileId: targetProfile.id,
					previousProfileId: currentProfile.id,
					harnessId: harness.id,
					harnessRevision: harness.revision,
					notice,
					reason: decision.reason,
				});
			},
		);
	}

	private async preparePrompt(text: string, options: PromptOptions | undefined): Promise<PreparedRuntimePrompt> {
		const routingPrompt = resolvePromptForProfileRouting(this.session, text);
		if (
			this._profileRouting === "auto" &&
			this._activeHarness === undefined &&
			this.harnessResolutionClaimed &&
			routingPrompt !== undefined &&
			!this.session.isStreaming
		) {
			await this.harnessResolutionGate;
		}
		if (
			this._profileRouting === "pinned" ||
			(this._activeHarness === undefined && this.harnessResolutionClaimed) ||
			routingPrompt === undefined
		) {
			return this.startSessionPrompt(text, options, {
				routing: "bypassed",
				activeProfileId: this.activeProfile.id,
				...(this._activeHarness
					? { harnessId: this._activeHarness.id, harnessRevision: this._activeHarness.revision }
					: {}),
			});
		}
		if (this._activeHarness !== undefined) {
			if (this.session.isStreaming || this.session.isCompacting || options?.streamingBehavior !== undefined) {
				return this.startSessionPrompt(text, options, {
					routing: "bypassed",
					activeProfileId: this.activeProfile.id,
					harnessId: this._activeHarness.id,
					harnessRevision: this._activeHarness.revision,
				});
			}
			return this.prepareFutureTaskPrompt(text, routingPrompt, options);
		}

		this.harnessResolutionClaimed = true;
		this.harnessResolutionGate = new Promise<void>((resolveGate) => {
			this.settleHarnessResolutionGate = resolveGate;
		});
		const messageCountBefore = this.session.messages.filter(
			(message) => message.role === "user" || message.role === "assistant",
		).length;
		const prepared = await this.startSessionPrompt(text, options, {
			routing: "bypassed",
			activeProfileId: this.activeProfile.id,
		});
		return { ...prepared, resolution: { prompt: routingPrompt, messageCountBefore } };
	}

	private async activateHarness(harness: ResolvedHarnessDescriptor, profile: ResolvedTaskProfile): Promise<void> {
		const sessionManager = this.session.sessionManager;
		const nextRuntime = await this.createRuntime({
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			profile: profile.id,
			profileRouting: "auto",
			harnessId: harness.id,
			telemetryContext: this.services.telemetryContext,
			telemetryCapture: this.services.telemetryCapture,
			sessionStartEvent: { type: "session_start", reason: "new" },
		});
		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(nextRuntime, "auto", harness.id);
		await this.finishSessionReplacement();
	}

	private async resolveHarnessAfterInitialTurn(prompt: string): Promise<RuntimePromptResult> {
		const previousProfileId = this.activeProfile.id;
		return startProfileRouteSpan(
			this.services.telemetryContext,
			{
				sessionId: this.session.sessionManager.getSessionId(),
				routingMode: this._profileRouting,
				trigger: "initial_turn",
				currentProfileId: previousProfileId,
				sessionEstablished: true,
			},
			async ({ context: routeContext, complete }) => {
				try {
					const profiles = this.services.resourceLoader
						.getProfiles()
						.profiles.filter((profile) => profile.origin === "builtin" && profile.immutable);
					const loadedHarnesses = loadHarnessDescriptors({
						agentDir: this.services.agentDir,
						notes: this.services.resourceLoader.getEvolvedNotes().evolvedNotes,
					});
					for (const diagnostic of loadedHarnesses.diagnostics) {
						this.appendDiagnostic(`Could not load harness descriptor ${diagnostic.path}: ${diagnostic.message}`);
					}
					const reusableHarnesses = loadedHarnesses.harnesses.filter(
						(harness) =>
							harness.harnessNoteCount > 0 && profiles.some((profile) => profile.id === harness.baseProfileId),
					);
					const decision = await routeTaskProfile(
						{
							prompt,
							recentTaskContext: buildRecentTaskContext(this.session.messages),
							candidates: profiles,
							harnesses: reusableHarnesses,
						},
						(routerPrompt) => this.completeProfileRoute(routerPrompt, routeContext),
					);
					if (decision.fallback) {
						const detail = decision.fallbackDetail ? `: ${decision.fallbackDetail}` : "";
						this.appendDiagnostic(`Task profile router used ${decision.fallback} fallback${detail}`, true);
					}

					let harness: ResolvedHarnessDescriptor;
					if (decision.decision === "reuse") {
						const existingHarness = reusableHarnesses.find((candidate) => candidate.id === decision.harnessId);
						if (!existingHarness)
							throw new Error(`Profile router selected unknown harness "${decision.harnessId}"`);
						harness = existingHarness;
					} else {
						harness = createHarnessDescriptor({
							agentDir: this.services.agentDir,
							name: decision.harnessName ?? "General task",
							description: decision.harnessDescription ?? "Harness for the current task.",
							baseProfileId: decision.profileId,
							notes: this.services.resourceLoader.getEvolvedNotes().evolvedNotes,
						});
					}
					const profile = profiles.find((candidate) => candidate.id === harness.baseProfileId);
					if (!profile) throw new Error(`Harness references unknown immutable profile "${harness.baseProfileId}"`);
					await this.activateHarness(harness, profile);

					const reused = decision.decision === "reuse";
					const notice = reused
						? `Found evolved harness "${harness.name}" for this task. Switched to revision ${harness.revision.slice(0, 12)}.`
						: `Created harness "${harness.name}" using the ${profile.name} prompt profile.`;
					try {
						this.profileSwitchListener?.({
							fromProfileId: previousProfileId,
							toProfileId: profile.id,
							reason: decision.reason,
							harnessId: harness.id,
							harnessRevision: harness.revision,
							harnessName: harness.name,
							reused,
							notice,
						});
					} catch (error) {
						this.appendDiagnostic(
							`Task profile switch listener failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					const result: RuntimePromptResult = {
						routing: reused ? "reused" : "selected",
						activeProfileId: profile.id,
						previousProfileId,
						harnessId: harness.id,
						harnessRevision: harness.revision,
						notice,
						reason: decision.reason,
					};
					complete({
						outcome: result.routing,
						targetProfileId: profile.id,
						harnessId: harness.id,
						confidence: decision.confidence,
						...(decision.fallback ? { fallback: ROUTE_FALLBACK_TELEMETRY[decision.fallback] } : {}),
					});
					return result;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.appendDiagnostic(`Task profile routing failed; continuing with "${previousProfileId}": ${message}`);
					complete({ outcome: "failed", targetProfileId: previousProfileId });
					return { routing: "failed", activeProfileId: previousProfileId, reason: message };
				}
			},
		);
	}

	/** Run the accepted first task on DEFAULT, then resolve this session's harness exactly once. */
	async prompt(text: string, options?: PromptOptions): Promise<RuntimePromptResult> {
		const prepared = await this.enqueuePromptPreparation(() => this.preparePrompt(text, options));
		if (prepared.cancelledError) throw prepared.cancelledError;
		try {
			await prepared.completion;
		} catch (error) {
			if (prepared.resolution) {
				this.harnessResolutionClaimed = false;
				this.settleHarnessResolutionGate?.();
			}
			throw error;
		}
		if (!prepared.resolution) return prepared.result;
		const messageCountAfter = this.session.messages.filter(
			(message) => message.role === "user" || message.role === "assistant",
		).length;
		if (!prepared.accepted || messageCountAfter <= prepared.resolution.messageCountBefore) {
			this.harnessResolutionClaimed = false;
			this.settleHarnessResolutionGate?.();
			return prepared.result;
		}
		try {
			return await this.resolveHarnessAfterInitialTurn(prepared.resolution.prompt);
		} finally {
			this.settleHarnessResolutionGate?.();
		}
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;

		let resolveDispose!: () => void;
		let rejectDispose!: (reason: unknown) => void;
		const disposePromise = new Promise<void>((resolve, reject) => {
			resolveDispose = resolve;
			rejectDispose = reject;
		});
		this.disposePromise = disposePromise;
		void this.teardownCurrent("quit").then(resolveDispose, rejectDispose);
		return disposePromise;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /clear, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		profile?: string;
		profileRouting?: ProfileRoutingMode;
		harnessId?: string;
		telemetryContext?: AgentSessionServices["telemetryContext"];
		telemetryCapture?: AgentSessionServices["telemetryCapture"];
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const persistedSelection = getProfileSelection(options.sessionManager);
	const requestedRouting = options.profileRouting ?? persistedSelection.profileRouting ?? "auto";
	const requestedHarnessId = options.harnessId ?? persistedSelection.harnessId;
	const loadedHarnesses = requestedHarnessId
		? loadHarnessDescriptors({ agentDir: options.agentDir })
		: { harnesses: [], diagnostics: [] };
	const restoredHarness = loadedHarnesses.harnesses.find((harness) => harness.id === requestedHarnessId);
	const harnessId = restoredHarness?.id;
	const profile =
		restoredHarness?.baseProfileId ??
		(requestedRouting === "auto" ? "general" : (options.profile ?? persistedSelection.profile));
	const result = await createRuntime({
		...options,
		profile,
		profileRouting: requestedRouting,
		harnessId,
	});
	const profileRouting = result.session.sessionManager.getHeader()?.profile?.routing ?? requestedRouting ?? "auto";
	const diagnostics = result.deniedToolsMessage
		? [...result.diagnostics, { type: "warning" as const, message: result.deniedToolsMessage }]
		: result.diagnostics;
	for (const diagnostic of loadedHarnesses.diagnostics) {
		diagnostics.push({
			type: "warning",
			message: `Could not load harness descriptor ${diagnostic.path}: ${diagnostic.message}`,
		});
	}
	if (requestedHarnessId && !restoredHarness) {
		diagnostics.push({
			type: "warning",
			message: `Could not restore harness "${requestedHarnessId}"; ${requestedRouting === "auto" ? "falling back to DEFAULT" : "keeping the pinned profile"}.`,
		});
	}
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		diagnostics,
		result.modelFallbackMessage,
		profileRouting,
		harnessId,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
