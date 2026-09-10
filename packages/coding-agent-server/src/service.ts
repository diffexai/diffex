import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@diffexai/diffex";
import type {
	ModelMetadata,
	ModelRef,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
	UserTranscriptItem,
} from "@diffexai/diffex-protocol";
import {
	type CreateSessionOptions,
	DiffexServerError,
	type DiffexServerService,
	type DiffexSessionRuntime,
	type DiffexSessionRuntimeEvent,
	type PromptInput,
	type SteerInput,
	toProtocolAssistantMessage,
	toProtocolModelMetadata,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "@diffexai/diffex-server";
import type { RuntimeUsageReporter } from "./usage-reporter.ts";
export interface HostedCodingAgentServiceOptions {
	sessionId: string;
	cwd: string;
	agentDir?: string;
	sessionDir?: string;
	modelRuntime?: ModelRuntime;
	defaultModel?: ModelRef;
	modelBaseUrl?: string;
	ownerUserId?: string;
	orgId?: string;
	usageReporter?: Pick<RuntimeUsageReporter, "record">;
}

/** Creates the one-cloud-session-per-sandbox service used by the hosted runtime. */
export async function createHostedCodingAgentService(
	options: HostedCodingAgentServiceOptions,
): Promise<DiffexServerService> {
	const agentDir = options.agentDir ?? getAgentDir();
	const sessionDir = options.sessionDir ?? join(agentDir, "hosted-sessions");
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		}));
	const existingSession = (await SessionManager.list(options.cwd, sessionDir)).find(
		(session) => session.id === options.sessionId,
	);
	const initialManager = existingSession
		? SessionManager.open(existingSession.path, sessionDir, options.cwd)
		: SessionManager.create(options.cwd, sessionDir, {
				id: options.sessionId,
				persistImmediately: true,
			});
	const sessionFile = initialManager.getSessionFile();
	const sessionHeader = initialManager.getHeader();
	if (!sessionFile || !sessionHeader) {
		throw new Error("Hosted session persistence was not initialized");
	}
	let acquired = false;
	const createdAt = Date.parse(sessionHeader.timestamp);

	const openRuntime = async (): Promise<DiffexSessionRuntime> => {
		if (acquired) throw new DiffexServerError("session_locked", "Hosted session is already acquired");
		acquired = true;
		try {
			const manager = SessionManager.open(sessionFile, sessionDir, options.cwd);
			const { session } = await createAgentSession({
				cwd: options.cwd,
				agentDir,
				modelRuntime,
				sessionManager: manager,
				...(options.defaultModel
					? {
							model: requiredModel(modelRuntime, options.defaultModel, options.modelBaseUrl),
						}
					: {}),
			});
			return new CodingAgentProtocolRuntime(
				session,
				options.defaultModel,
				options.modelBaseUrl,
				options.usageReporter,
				options.ownerUserId,
				options.orgId,
				() => {
					acquired = false;
				},
			);
		} catch (error) {
			acquired = false;
			throw error;
		}
	};

	return {
		listSessions(): Promise<SessionMetadata[]> {
			return Promise.resolve([
				{
					id: options.sessionId,
					createdAt,
					updatedAt: Date.now(),
					cwd: options.cwd,
				},
			]);
		},
		listModels(): Promise<ModelMetadata[]> {
			const configured = options.defaultModel;
			return Promise.resolve(
				modelRuntime
					.getAvailableSnapshot()
					.filter((model) => !configured || (model.provider === configured.provider && model.id === configured.id))
					.map((model) => toProtocolModelMetadata(model, modelRuntime.hasConfiguredAuth(model.provider))),
			);
		},
		createSession(_input: CreateSessionOptions): Promise<DiffexSessionRuntime> {
			return Promise.reject(
				new DiffexServerError("not_implemented", "Hosted sessions are allocated by the Diffex cloud control plane"),
			);
		},
		openSession(sessionId: string): Promise<DiffexSessionRuntime> {
			if (sessionId !== options.sessionId) {
				return Promise.reject(new DiffexServerError("not_found", "Hosted session not found"));
			}
			return openRuntime();
		},
	};
}

function requiredModel(modelRuntime: ModelRuntime, model: ModelRef, baseUrl?: string) {
	const resolved = modelRuntime.getModel(model.provider, model.id);
	if (!resolved) {
		throw new DiffexServerError("not_found", `Configured runtime model was not found: ${model.provider}/${model.id}`);
	}
	if (!modelRuntime.hasConfiguredAuth(model.provider)) {
		throw new DiffexServerError("invalid_request", `Configured runtime model has no credentials: ${model.provider}`);
	}
	return baseUrl ? { ...resolved, baseUrl } : resolved;
}

class CodingAgentProtocolRuntime implements DiffexSessionRuntime {
	readonly #session: AgentSession;
	readonly #configuredModel: ModelRef | undefined;
	readonly #modelBaseUrl: string | undefined;
	readonly #usageReporter: Pick<RuntimeUsageReporter, "record"> | undefined;
	readonly #ownerUserId: string | undefined;
	readonly #orgId: string | undefined;
	readonly #release: () => void;
	readonly #listeners = new Set<(event: DiffexSessionRuntimeEvent) => void>();
	readonly #unsubscribe: () => void;
	#revision = 0;
	#disposed = false;
	#phase: SessionPhase;
	#queuedSteer: UserTranscriptItem[] = [];

	constructor(
		session: AgentSession,
		configuredModel: ModelRef | undefined,
		modelBaseUrl: string | undefined,
		usageReporter: Pick<RuntimeUsageReporter, "record"> | undefined,
		ownerUserId: string | undefined,
		orgId: string | undefined,
		release: () => void,
	) {
		this.#session = session;
		this.#configuredModel = configuredModel;
		this.#modelBaseUrl = modelBaseUrl;
		this.#usageReporter = usageReporter;
		this.#ownerUserId = ownerUserId;
		this.#orgId = orgId;
		this.#release = release;
		this.#phase = session.isStreaming ? "turn" : "idle";
		this.#queuedSteer = reconcileQueuedSteer([], session.getSteeringMessages());
		this.#unsubscribe = session.subscribe((event) => this.#handleEvent(event));
	}

	snapshot(): SessionSnapshot {
		const header = this.#session.sessionManager.getHeader();
		const model = this.#session.model;
		if (!header || !model) {
			throw new Error("Hosted session is not initialized");
		}
		const entries = this.#session.sessionManager.getBranch();
		const updatedAt = entries.at(-1)?.timestamp ?? header.timestamp;
		const name = this.#session.sessionManager.getSessionName();
		return {
			id: header.id,
			...(name ? { name } : {}),
			cwd: this.#session.sessionManager.getCwd(),
			createdAt: Date.parse(header.timestamp),
			updatedAt: Date.parse(updatedAt),
			phase: this.getPhase(),
			model: { provider: model.provider, id: model.id },
			thinkingLevel: this.#session.thinkingLevel,
			attached: true,
			locked: true,
			revision: this.#revision,
			transcript: projectTranscript(this.#session),
			queuedSteer: this.#queuedSteer,
			queuedSteerCount: this.#queuedSteer.length,
		};
	}

	getPhase(): SessionPhase {
		return this.#phase;
	}

	async prompt(input: PromptInput): Promise<void> {
		await this.#session.prompt(input.text);
	}

	async steer(input: SteerInput): Promise<void> {
		await this.#session.steer(input.text);
	}

	async abort(): Promise<void> {
		await this.#session.abort();
	}

	async setModel(model: ModelRef): Promise<void> {
		if (
			this.#configuredModel &&
			(model.provider !== this.#configuredModel.provider || model.id !== this.#configuredModel.id)
		) {
			throw new DiffexServerError("not_found", "Model is not available in this hosted session");
		}
		const resolved = requiredModel(this.#session.modelRuntime, model, this.#modelBaseUrl);
		await this.#session.setModel(resolved);
	}

	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		this.#session.setThinkingLevel(thinkingLevel);
	}

	subscribe(listener: (event: DiffexSessionRuntimeEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		this.#listeners.clear();
		try {
			await this.#session.dispose();
		} finally {
			this.#release();
		}
	}

	#handleEvent(event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant" && this.#usageReporter) {
			const message = event.message;
			this.#usageReporter.record({
				eventId: assistantUsageEventId(this.#session.sessionManager.getSessionId(), message),
				sessionId: this.#session.sessionManager.getSessionId(),
				ownerUserId: requiredUsageIdentity("ownerUserId", this.#ownerUserId),
				orgId: requiredUsageIdentity("orgId", this.#orgId),
				provider: message.provider,
				model: message.model,
				usage: {
					input: message.usage.input,
					output: message.usage.output,
					cacheRead: message.usage.cacheRead,
					cacheWrite: message.usage.cacheWrite,
				},
				occurredAt: message.timestamp,
			});
		}
		this.#phase = phaseAfterEvent(this.#phase, event, this.#session.isStreaming);
		if (event.type === "queue_update") {
			this.#queuedSteer = reconcileQueuedSteer(this.#queuedSteer, event.steering);
		}
		this.#revision += 1;
		for (const listener of this.#listeners) listener({ type: "snapshot" });
	}
}

function requiredUsageIdentity(name: string, value: string | undefined): string {
	if (!value) throw new Error(`Hosted runtime ${name} is not configured`);
	return value;
}

function assistantUsageEventId(
	sessionId: string,
	message: Extract<AgentSessionEvent, { type: "message_end" }>["message"],
): string {
	return createHash("sha256").update(sessionId).update("\0").update(JSON.stringify(message)).digest("hex");
}

function projectTranscript(session: AgentSession): TranscriptItem[] {
	const result: TranscriptItem[] = [];
	const toolCalls = new Map<string, ToolCall>();
	for (const entry of session.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			result.push(toProtocolUserMessage(message, { id: entry.id }));
		} else if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "toolCall") toolCalls.set(content.id, content);
			}
			result.push(toProtocolAssistantMessage(message, { id: entry.id }));
		} else if (message.role === "toolResult") {
			const call = toolCalls.get(message.toolCallId);
			if (!call) {
				throw new Error(`Tool result ${message.toolCallId} has no matching tool call in the active branch`);
			}
			result.push(toProtocolToolResultMessage(message, { id: entry.id, call }));
		}
	}
	return result;
}

type ToolCall = Parameters<typeof toProtocolToolResultMessage>[1]["call"];

function reconcileQueuedSteer(
	previous: readonly UserTranscriptItem[],
	messages: readonly string[],
): UserTranscriptItem[] {
	const remaining = [...previous];
	return messages.map((text) => {
		const index = remaining.findIndex(
			(item) => item.content.length === 1 && item.content[0]?.type === "text" && item.content[0].text === text,
		);
		if (index >= 0) {
			return remaining.splice(index, 1)[0]!;
		}
		return {
			id: `queued-${randomUUID()}`,
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
	});
}

function phaseAfterEvent(current: SessionPhase, event: AgentSessionEvent, isStreaming: boolean): SessionPhase {
	switch (event.type) {
		case "compaction_start":
			return "compaction";
		case "summarization_retry_attempt_start":
			return event.source === "branchSummary" ? "branch_summary" : "compaction";
		case "auto_retry_start":
		case "summarization_retry_scheduled":
			return "retry";
		case "agent_start":
		case "turn_start":
			return "turn";
		case "agent_settled":
		case "summarization_retry_finished":
			return isStreaming ? "turn" : "idle";
		case "compaction_end":
		case "auto_retry_end":
			return isStreaming ? "turn" : "idle";
		default:
			return current;
	}
}
