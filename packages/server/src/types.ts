import type {
	Command,
	ModelMetadata,
	ModelRef,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptProgress,
} from "@diffexai/diffex-protocol";
import type { DiffexServerError } from "./errors.ts";
import type { DiffexServerListener } from "./listener.ts";

export interface DiffexServerOptions {
	listeners: readonly DiffexServerListener[];
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	serverId?: string;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

export type PromptInput = Omit<Extract<Command, { command: "prompt" }>, "command" | "sessionId">;
export type SteerInput = Omit<Extract<Command, { command: "steer" }>, "command" | "sessionId">;

export interface CreateSessionOptions {
	/** A collision-resistant ID assigned by DiffexServer. The service must persist this exact ID. */
	id: string;
	cwd?: string;
	name?: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

export type DiffexSessionRuntimeEvent =
	| { type: "snapshot" }
	| { type: "progress"; progress: TranscriptProgress }
	| { type: "error"; error: DiffexServerError };

/** One acquired durable session. Conflicting operations must reject rather than queue. */
export interface DiffexSessionRuntime {
	snapshot(): MaybePromise<SessionSnapshot>;
	getPhase(): SessionPhase;
	prompt(input: PromptInput): Promise<void>;
	steer(input: SteerInput): Promise<void>;
	abort(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
	subscribe(listener: (event: DiffexSessionRuntimeEvent) => void): () => void;
	dispose(): Promise<void>;
}

/** Service boundary for durable sessions and exclusively acquired runtimes. */
export interface DiffexServerService {
	listSessions(): Promise<SessionMetadata[]>;
	listModels(): Promise<ModelMetadata[]>;
	createSession(options: CreateSessionOptions): Promise<DiffexSessionRuntime>;
	openSession(sessionId: string): Promise<DiffexSessionRuntime>;
}

export type SessionRuntime = DiffexSessionRuntime;
export type SessionRuntimeEvent = DiffexSessionRuntimeEvent;
