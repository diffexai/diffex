import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";

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

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods reserve the current runtime until the successor
 * is ready. If creation fails, the error is propagated to the caller and the
 * current runtime remains valid. The caller is responsible for user-facing
 * error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private disposePromise: Promise<void> | undefined;
	private exclusiveRuntimeOperation: object | undefined;
	private exclusiveRuntimeOperationSettled: Promise<void> = Promise.resolve();
	private disposeRequested = false;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
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

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
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

	private async runSessionReplacement<T>(operation: () => Promise<T>): Promise<T> {
		return this.runExclusiveRuntimeOperation(operation);
	}

	private async runExclusiveRuntimeOperation<T>(operation: (owner: object) => Promise<T>): Promise<T> {
		this.assertExclusiveRuntimeIdle();
		const owner = {};
		let settleOperation!: () => void;
		const settled = new Promise<void>((resolveSettled) => {
			settleOperation = resolveSettled;
		});
		this.exclusiveRuntimeOperation = owner;
		this.exclusiveRuntimeOperationSettled = settled;
		try {
			return await operation(owner);
		} finally {
			if (this.exclusiveRuntimeOperation === owner) this.exclusiveRuntimeOperation = undefined;
			settleOperation();
		}
	}

	private assertExclusiveRuntimeIdle(): void {
		if (this.disposeRequested) {
			throw new Error("Agent session runtime is disposing.");
		}
		if (this.exclusiveRuntimeOperation) {
			throw new Error("Another session replacement or exclusive runtime operation is already in progress.");
		}
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

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	private async commitReservedRuntime(
		result: CreateAgentSessionRuntimeResult,
		outgoingSession: AgentSession,
		releaseReplacement: () => void,
		options: {
			reason: SessionShutdownEvent["reason"];
			targetSessionFile?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
	): Promise<void> {
		let shutdownStarted = false;
		let adopted = false;
		let hasPostShutdownError = false;
		let postShutdownError: unknown;
		const postShutdownDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const recordPostShutdownError = (stage: string, error: unknown): void => {
			if (!hasPostShutdownError) postShutdownError = error;
			hasPostShutdownError = true;
			postShutdownDiagnostics.push({
				type: "warning",
				message: `Session replacement ${stage} failed after shutdown began: ${error instanceof Error ? error.message : String(error)}`,
			});
		};

		try {
			shutdownStarted = true;
			try {
				await emitSessionShutdownEvent(outgoingSession.extensionRunner, {
					type: "session_shutdown",
					reason: options.reason,
					targetSessionFile: options.targetSessionFile,
				});
			} catch (error) {
				recordPostShutdownError("shutdown hook", error);
			}
			try {
				this.beforeSessionInvalidate?.();
			} catch (error) {
				recordPostShutdownError("invalidation", error);
			}
			try {
				outgoingSession.dispose();
			} catch (error) {
				recordPostShutdownError("disposal", error);
			}
			try {
				this.apply(result);
				adopted = true;
			} catch (error) {
				recordPostShutdownError("activation", error);
			}
			if (!adopted) {
				this._session = result.session;
				this._services = result.services;
				adopted = true;
			}
			try {
				await this.finishSessionReplacement(options.withSession);
			} catch (error) {
				recordPostShutdownError("host rebind", error);
			}
			this._diagnostics = [...this._diagnostics, ...postShutdownDiagnostics];
			if (hasPostShutdownError) throw postShutdownError;
		} finally {
			if (!shutdownStarted) {
				releaseReplacement();
				if (!adopted) {
					void result.session.dispose();
				}
			}
			// A disposed outgoing session intentionally retains its replacement lease.
			// This keeps stale references from mutating a SessionManager shared with the adopted runtime.
		}
	}

	private async replaceCurrentRuntime(
		createRuntime: () => Promise<CreateAgentSessionRuntimeResult>,
		options: {
			reason: SessionShutdownEvent["reason"];
			targetSessionFile?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
	): Promise<void> {
		// Settle any active response first so the aborted turn, including tool
		// results, is persisted before the outgoing session is replaced.
		const outgoingSession = this.session;
		await outgoingSession.abort();
		const releaseReplacement = outgoingSession.reserveRuntimeReplacement();
		let result: CreateAgentSessionRuntimeResult;
		try {
			result = await createRuntime();
		} catch (error) {
			releaseReplacement();
			throw error;
		}
		await this.commitReservedRuntime(result, outgoingSession, releaseReplacement, options);
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		return this.runSessionReplacement(async () => {
			const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
			if (beforeResult.cancelled) {
				return beforeResult;
			}

			const previousSessionFile = this.session.sessionFile;
			const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
			await this.replaceCurrentRuntime(
				() =>
					this.createRuntime({
						cwd: sessionManager.getCwd(),
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
						projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
					}),
				{
					reason: "resume",
					targetSessionFile: sessionManager.getSessionFile(),
					withSession: options?.withSession,
				},
			);
			return { cancelled: false };
		});
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		return this.runSessionReplacement(async () => {
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
			if (options?.setup) {
				await options.setup(sessionManager);
			}

			await this.replaceCurrentRuntime(
				() =>
					this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
					}),
				{
					reason: "new",
					targetSessionFile: sessionManager.getSessionFile(),
					withSession: options?.withSession,
				},
			);
			return { cancelled: false };
		});
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
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
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
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
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
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
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
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposeRequested = true;
		const activeOperation = this.exclusiveRuntimeOperationSettled;

		let resolveDispose!: () => void;
		let rejectDispose!: (reason: unknown) => void;
		const disposePromise = new Promise<void>((resolve, reject) => {
			resolveDispose = resolve;
			rejectDispose = reject;
		});
		this.disposePromise = disposePromise;
		void activeOperation.then(() => this.teardownCurrent("quit")).then(resolveDispose, rejectDispose);
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
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
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
