import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type ModelsRequestTransforms,
	type ProviderRequestOptions,
	type StreamOptions,
} from "@diffexai/diffex-ai";

export interface HostedModelGatewayOptions {
	baseUrl: string;
	credential: string;
	provider: string;
	modelId: string;
	maxOutputTokens: number;
	/** Persistent runtime directory containing private operation metadata. */
	stateDirectory: string;
}

/** A gateway failure must never trigger a new billable generation automatically. */
export class HostedModelGatewayError extends Error {
	readonly code: string;
	readonly operationId: string | undefined;

	constructor(code: string, operationId?: string) {
		super(`gateway_${code}${operationId ? ` (operation ${operationId})` : ""}`);
		this.name = "HostedModelGatewayError";
		this.code = code;
		this.operationId = operationId;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class HostedModelGateway {
	readonly options: Readonly<HostedModelGatewayOptions>;
	private readonly directory: string;

	private constructor(options: HostedModelGatewayOptions, directory: string) {
		this.options = Object.freeze({ ...options });
		this.directory = directory;
	}

	static async create(options: HostedModelGatewayOptions): Promise<HostedModelGateway> {
		const url = new URL(options.baseUrl);
		const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
		if (
			(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!/^\/v1\/runtime\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/model\/?$/iu.test(
				url.pathname,
			) ||
			!/^[\x21-\x7e]{1,4096}$/u.test(options.credential) ||
			options.provider !== "anthropic" ||
			!options.modelId ||
			!Number.isSafeInteger(options.maxOutputTokens) ||
			options.maxOutputTokens <= 0 ||
			options.maxOutputTokens > 2_147_483_647 ||
			!isAbsolute(options.stateDirectory)
		) {
			throw new HostedModelGatewayError("invalid_configuration");
		}
		const directory = resolve(options.stateDirectory, "model-operations");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const info = await lstat(directory);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			(info.mode & 0o077) !== 0 ||
			(await realpath(directory)) !== directory
		) {
			throw new HostedModelGatewayError("invalid_state_directory");
		}
		// Sync all ancestors even when an interrupted earlier startup created them.
		for (let current = directory; ; current = dirname(current)) {
			await syncDirectory(current);
			if (dirname(current) === current) break;
		}
		return new HostedModelGateway({ ...options, baseUrl: url.toString().replace(/\/$/u, "") }, directory);
	}

	assertModel(model: Model<Api>): void {
		if (
			model.provider !== this.options.provider ||
			model.id !== this.options.modelId ||
			model.api !== "anthropic-messages" ||
			(model.baseUrl !== this.options.baseUrl && model.baseUrl !== "https://api.anthropic.com") ||
			model.headers !== undefined
		) {
			throw new HostedModelGatewayError("model_override_forbidden");
		}
	}

	stream(
		model: Model<Api>,
		requestOptions: (StreamOptions & ModelsRequestTransforms & { client?: unknown }) | undefined,
		start: (options: ProviderRequestOptions) => AssistantMessageEventStream,
	): AssistantMessageEventStream {
		const outer = createAssistantMessageEventStream();
		const operationId = randomUUID();
		const pendingPath = join(this.directory, `${operationId}.json`);
		let sent = false;
		let recorded = false;
		let localFailureCode: string | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			if (sent) {
				localFailureCode = "automatic_retry_forbidden";
				throw new HostedModelGatewayError(localFailureCode, operationId);
			}
			const request = new Request(input, init);
			if (request.url !== `${this.options.baseUrl}/v1/messages` || request.method !== "POST") {
				localFailureCode = "endpoint_override_forbidden";
				throw new HostedModelGatewayError(localFailureCode, operationId);
			}
			const body = await request.text();
			const payload: unknown = JSON.parse(body);
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				localFailureCode = "invalid_request";
				throw new HostedModelGatewayError(localFailureCode, operationId);
			}
			const parameters = payload as Record<string, unknown>;
			const thinking = parameters.thinking as Record<string, unknown> | undefined;
			if (
				parameters.model !== this.options.modelId ||
				parameters.stream !== true ||
				!Number.isSafeInteger(parameters.max_tokens) ||
				(parameters.max_tokens as number) <= 0 ||
				(parameters.max_tokens as number) > this.options.maxOutputTokens ||
				(thinking?.type === "enabled" &&
					(!Number.isSafeInteger(thinking.budget_tokens) ||
						(thinking.budget_tokens as number) >= (parameters.max_tokens as number)))
			) {
				localFailureCode = "invalid_request";
				throw new HostedModelGatewayError(localFailureCode, operationId);
			}
			try {
				const handle = await open(
					pendingPath,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				);
				try {
					await handle.writeFile(
						JSON.stringify({
							version: 1,
							operationId,
							model: this.options.modelId,
							requestDigest: createHash("sha256").update(body).digest("hex"),
							createdAt: new Date().toISOString(),
						}),
					);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await syncDirectory(this.directory);
				recorded = true;
			} catch {
				localFailureCode = "local_journal_unavailable";
				throw new HostedModelGatewayError(localFailureCode, operationId);
			}
			request.signal.throwIfAborted();
			sent = true;
			return globalThis.fetch(request.url, {
				method: "POST",
				body,
				signal: request.signal,
				redirect: "error",
				headers: {
					"content-type": "application/json",
					accept: "text/event-stream",
					"x-api-key": this.options.credential,
					"x-diffex-operation-id": operationId,
				},
			});
		};
		const fail = (message: AssistantMessage, code: string): void => {
			message.retryable = false;
			message.errorMessage = new HostedModelGatewayError(code, operationId).message;
			message.diagnostics = [
				...(message.diagnostics ?? []),
				{
					type: "model_gateway_failure",
					timestamp: Date.now(),
					error: { name: "HostedModelGatewayError", message: message.errorMessage, code },
					details: { operationId },
				},
			];
		};
		void (async () => {
			try {
				this.assertModel(model);
				if (requestOptions?.maxTokens !== undefined && requestOptions.maxTokens > this.options.maxOutputTokens) {
					throw new HostedModelGatewayError("invalid_request", operationId);
				}
				if (
					requestOptions?.fetch ||
					requestOptions?.client ||
					requestOptions?.env ||
					(requestOptions?.apiKey !== undefined && requestOptions.apiKey !== this.options.credential)
				) {
					throw new HostedModelGatewayError("transport_override_forbidden", operationId);
				}
				const inner = start({
					...requestOptions,
					// This is an SDK auth placeholder; only fetch() handles the gateway credential.
					apiKey: "diffex-hosted-model-gateway",
					headers: undefined,
					fetch,
					maxRetries: 0,
				});
				for await (const event of inner) {
					if (event.type === "start") {
						event.partial.diagnostics = [
							...(event.partial.diagnostics ?? []),
							{
								type: "model_gateway_operation",
								timestamp: Date.now(),
								details: { operationId },
							},
						];
					} else if (event.type === "error") {
						const code =
							localFailureCode ??
							event.error.errorMessage?.match(/gateway_([a-z_]+)/u)?.[1] ??
							"transport_or_stream_interrupted";
						fail(event.error, code);
					} else if (event.type === "done" && recorded) {
						try {
							await unlink(pendingPath);
							await syncDirectory(this.directory);
						} catch {
							// A cleanup failure cannot invalidate an already completed generation.
							event.message.diagnostics = [
								...(event.message.diagnostics ?? []),
								{
									type: "model_gateway_pending_cleanup_failed",
									timestamp: Date.now(),
									error: {
										name: "HostedModelGatewayError",
										code: "local_journal_cleanup_unavailable",
										message: "Pending operation metadata cleanup failed",
									},
									details: { operationId },
								},
							];
						}
					}
					outer.push(event);
				}
				outer.end(await inner.result());
			} catch (error) {
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: requestOptions?.signal?.aborted ? "aborted" : "error",
					timestamp: Date.now(),
				};
				fail(message, error instanceof HostedModelGatewayError ? error.code : "transport_or_stream_interrupted");
				outer.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
				outer.end(message);
			}
		})();
		return outer;
	}
}
