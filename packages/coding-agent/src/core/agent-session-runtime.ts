import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession, PromptOptions } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import { createGeneratedProfile, finalizeGeneratedProfile, loadEvolvedNotes } from "./evolved.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { routeTaskProfile } from "./profile-router.ts";
import type { ResolvedTaskProfile } from "./profiles.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
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
	routing: "bypassed" | "stayed" | "switched" | "created" | "failed";
	activeProfileId: string;
	previousProfileId?: string;
	reason?: string;
}

export interface ProfileSwitchEvent {
	fromProfileId: string;
	toProfileId: string;
	reason: string;
	generated: boolean;
}

interface PreparedRuntimePrompt {
	result: RuntimePromptResult;
	completion: Promise<void>;
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
	generatedProfiles?: ResolvedTaskProfile[];
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
const ROUTING_HANDOFF_MAX_CHARS = 2_000;
const ROUTING_TIMEOUT_MS = 15_000;
const BUILTIN_SLASH_COMMAND_NAMES = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

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
} {
	const metadata = sessionManager.getHeader()?.profile;
	if (!metadata) return {};
	return {
		profile: metadata.source ?? metadata.id,
		profileRouting: metadata.routing,
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
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private replacementDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
	private _modelFallbackMessage?: string;
	private _profileRouting: ProfileRoutingMode;
	private promptPreparationQueue: Promise<void> = Promise.resolve();

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		profileRouting?: ProfileRoutingMode,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this._profileRouting = profileRouting ?? _session.sessionManager.getHeader()?.profile?.routing ?? "auto";
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
		});
	}

	private finalizeCurrentGeneratedProfile(required = false): ResolvedTaskProfile | undefined {
		let profileId = "active";
		try {
			const profile = this.activeProfile;
			profileId = profile.id;
			if (profile.origin !== "generated") return undefined;
			const evolved = loadEvolvedNotes({
				agentDir: this.services.agentDir,
				cwd: this.cwd,
				projectTrusted: this.services.settingsManager.isProjectTrusted(),
			});
			for (const diagnostic of evolved.diagnostics) {
				this.appendDiagnostic(`Could not load evolved note ${diagnostic.path}: ${diagnostic.message}`, true);
			}
			const finalizedProfile = finalizeGeneratedProfile({
				agentDir: this.services.agentDir,
				profile,
				notes: evolved.notes,
			});
			this.syncProfileMetadata(finalizedProfile);
			return finalizedProfile;
		} catch (error) {
			const message = `Could not finalize generated profile "${profileId}": ${error instanceof Error ? error.message : String(error)}`;
			this.appendDiagnostic(message, true);
			if (required) throw new Error(message, { cause: error });
			return undefined;
		}
	}

	private async teardownCurrent(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
		finalizeGenerated = true,
	): Promise<void> {
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		await this.session.abort();
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		if (finalizeGenerated) this.finalizeCurrentGeneratedProfile();
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}

	private apply(result: CreateAgentSessionRuntimeResult, profileRouting?: ProfileRoutingMode): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = [...result.diagnostics, ...this.replacementDiagnostics];
		this.replacementDiagnostics = [];
		this._modelFallbackMessage = result.modelFallbackMessage;
		this._profileRouting = result.session.sessionManager.getHeader()?.profile?.routing ?? profileRouting ?? "auto";
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
		const profileSelection = getProfileSelection(sessionManager);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				profile: profileSelection.profile,
				profileRouting: profileSelection.profileRouting,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
			profileSelection.profileRouting,
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		profile?: string;
		profileRouting?: ProfileRoutingMode;
		generatedProfiles?: ResolvedTaskProfile[];
		hiddenHandoff?: string;
		reuseCurrentSessionManager?: boolean;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const reuseCurrentSessionManager =
			options?.reuseCurrentSessionManager === true &&
			!options.parentSession &&
			!this.session.messages.some((message) => message.role === "user" || message.role === "assistant");
		const sessionManager = reuseCurrentSessionManager
			? this.session.sessionManager
			: this.session.sessionManager.isPersisted()
				? SessionManager.create(this.cwd, sessionDir)
				: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		const targetRouting = options?.profileRouting ?? this._profileRouting;
		const targetProfile = options?.profile ?? this.getCurrentProfileSelection();
		const currentProfile = this.activeProfile;
		const reusesCurrentGeneratedProfile =
			currentProfile.origin === "generated" &&
			(targetProfile === currentProfile.id || resolve(targetProfile) === resolve(currentProfile.source.path));
		const finalizedProfile = reusesCurrentGeneratedProfile ? this.finalizeCurrentGeneratedProfile(true) : undefined;
		const generatedProfiles = finalizedProfile
			? [
					finalizedProfile,
					...(options?.generatedProfiles ?? []).filter((profile) => profile.id !== finalizedProfile.id),
				]
			: options?.generatedProfiles;
		const nextRuntime = await this.createRuntime({
			cwd: this.cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			profile: targetProfile,
			profileRouting: targetRouting,
			generatedProfiles,
			sessionStartEvent: {
				type: "session_start",
				reason: "new",
				...(reuseCurrentSessionManager ? {} : { previousSessionFile }),
			},
		});
		await this.teardownCurrent("new", sessionManager.getSessionFile(), !reusesCurrentGeneratedProfile);
		this.apply(nextRuntime, targetRouting);
		const hiddenHandoff = options?.hiddenHandoff?.trim().slice(0, ROUTING_HANDOFF_MAX_CHARS);
		let contextChanged = false;
		if (hiddenHandoff) {
			this.session.sessionManager.appendCustomMessageEntry("profile-router-handoff", hiddenHandoff, false, {
				fromSession: previousSessionFile,
				profile: this.activeProfile.id,
			});
			contextChanged = true;
		}
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
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
					targetRouting,
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
			const profileSelection = getProfileSelection(sessionManager);
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					profile: profileSelection.profile,
					profileRouting: profileSelection.profileRouting,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
				profileSelection.profileRouting,
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
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
			targetRouting,
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
		const profileSelection = getProfileSelection(sessionManager);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				profile: profileSelection.profile,
				profileRouting: profileSelection.profileRouting,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
			profileSelection.profileRouting,
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	private async completeProfileRoute(routerPrompt: string): Promise<string> {
		const model = this.session.model;
		if (!model) {
			throw new Error("No model is selected for task profile routing");
		}
		const response = await this.session.modelRuntime.completeSimple(
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
			},
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
		let settlePreflight: (() => void) | undefined;
		const preflight = new Promise<void>((resolvePreflight) => {
			settlePreflight = resolvePreflight;
		});
		let preflightSettled = false;
		const settle = () => {
			if (preflightSettled) return;
			preflightSettled = true;
			settlePreflight?.();
		};
		const completion = this.session.prompt(text, {
			...options,
			preflightResult: (success) => {
				try {
					options?.preflightResult?.(success);
				} finally {
					settle();
				}
			},
		});
		void completion.then(settle, settle);
		await preflight;
		return { result, completion };
	}

	private async preparePrompt(text: string, options: PromptOptions | undefined): Promise<PreparedRuntimePrompt> {
		const routingPrompt = resolvePromptForProfileRouting(this.session, text);
		if (this._profileRouting === "pinned" || routingPrompt === undefined) {
			return this.startSessionPrompt(text, options, {
				routing: "bypassed",
				activeProfileId: this.activeProfile.id,
			});
		}

		const currentProfile = this.activeProfile;
		const candidates = this.services.resourceLoader.getProfiles().profiles;
		const priorMessages = this.session.messages;
		const sessionEstablished = priorMessages.some(
			(message) => message.role === "user" || message.role === "assistant",
		);

		try {
			const decision = await routeTaskProfile(
				{
					currentProfile,
					prompt: routingPrompt,
					recentTaskContext: buildRecentTaskContext(priorMessages),
					candidates,
					sessionEstablished,
				},
				(routerPrompt) => this.completeProfileRoute(routerPrompt),
			);
			if (decision.fallback) {
				const detail = decision.fallbackDetail ? `: ${decision.fallbackDetail}` : "";
				this.appendDiagnostic(`Task profile router used ${decision.fallback} fallback${detail}`);
			}

			if (decision.decision === "stay" || decision.decision === "defer") {
				return this.startSessionPrompt(text, options, {
					routing: "stayed",
					activeProfileId: currentProfile.id,
					reason: decision.reason,
				});
			}

			let targetProfile: ResolvedTaskProfile;
			let generated = false;
			if (decision.decision === "switch") {
				const resolved = candidates.find((candidate) => candidate.id === decision.profileId);
				if (!resolved) {
					throw new Error(`Profile router selected unknown profile "${decision.profileId}"`);
				}
				targetProfile = resolved;
			} else {
				targetProfile = createGeneratedProfile({
					agentDir: this.services.agentDir,
					id: decision.profileId,
					label: decision.generatedLabel ?? decision.profileId,
					description: decision.generatedDescription ?? decision.reason,
					handoff: decision.handoff,
				});
				generated = true;
			}

			if (options?.streamingBehavior === "followUp" && this.session.isStreaming) {
				await this.session.waitForIdle();
			}
			const replacement = await this.newSession({
				parentSession: sessionEstablished ? this.session.sessionFile : undefined,
				profile: targetProfile.id,
				profileRouting: "auto",
				generatedProfiles: generated ? [targetProfile] : undefined,
				hiddenHandoff: decision.handoff,
				reuseCurrentSessionManager: !sessionEstablished,
			});
			if (replacement.cancelled) {
				return this.startSessionPrompt(text, options, {
					routing: "stayed",
					activeProfileId: currentProfile.id,
					reason: "Profile switch was cancelled by a session handler.",
				});
			}

			try {
				this.profileSwitchListener?.({
					fromProfileId: currentProfile.id,
					toProfileId: targetProfile.id,
					reason: decision.reason,
					generated,
				});
			} catch (error) {
				this.appendDiagnostic(
					`Task profile switch listener failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return this.startSessionPrompt(text, options, {
				routing: generated ? "created" : "switched",
				activeProfileId: targetProfile.id,
				previousProfileId: currentProfile.id,
				reason: decision.reason,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			let fallbackProfileId = currentProfile.id;
			try {
				fallbackProfileId = this.activeProfile.id;
			} catch {}
			this.appendDiagnostic(`Task profile routing failed; continuing with "${fallbackProfileId}": ${message}`);
			return this.startSessionPrompt(text, options, {
				routing: "failed",
				activeProfileId: fallbackProfileId,
				reason: message,
			});
		}
	}

	/** Route prompts before AgentSession accepts them, including queued steer/follow-up input. */
	async prompt(text: string, options?: PromptOptions): Promise<RuntimePromptResult> {
		const prepared = await this.enqueuePromptPreparation(() => this.preparePrompt(text, options));
		await prepared.completion;
		return prepared.result;
	}

	async dispose(): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this.finalizeCurrentGeneratedProfile();
		this.beforeSessionInvalidate?.();
		this.session.dispose();
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
		generatedProfiles?: ResolvedTaskProfile[];
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const persistedSelection = getProfileSelection(options.sessionManager);
	const requestedRouting = options.profileRouting ?? persistedSelection.profileRouting;
	const result = await createRuntime({
		...options,
		profile: options.profile ?? persistedSelection.profile,
		profileRouting: requestedRouting,
	});
	const profileRouting = result.session.sessionManager.getHeader()?.profile?.routing ?? requestedRouting ?? "auto";
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
		profileRouting,
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
