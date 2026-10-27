// Installed acceptance extension: only provider inference/HTTP are synthetic.
// Sessions, built-in tools, auth resolution, agent orchestration and UI remain real.
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { createAssistantMessageEventStream } from "@diffexai/diffex-ai";

const toolSteps = [
	{ name: "read", arguments: { path: "input.txt" } },
	{ name: "write", arguments: { path: "output.txt", content: "behavior-written\n" } },
	{
		name: "edit",
		arguments: { path: "output.txt", edits: [{ oldText: "written", newText: "edited" }] },
	},
	{ name: "bash", arguments: { command: "cat output.txt > bash-result.txt" } },
];

function textOf(message) {
	return typeof message.content === "string"
		? message.content
		: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function checkedResults(messages, promptIndex) {
	const following = messages.slice(promptIndex + 1);
	const calls = following.flatMap((message) =>
		message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
	);
	const results = following.filter((message) => message.role === "toolResult");
	if (results.length > toolSteps.length || calls.length !== results.length) {
		throw new Error("Behavior tools context has missing or extra tool results");
	}
	for (const [index, result] of results.entries()) {
		const step = toolSteps[index];
		const call = calls[index];
		if (
			result.isError ||
			result.toolName !== step.name ||
			call.name !== step.name ||
			call.id !== result.toolCallId ||
			JSON.stringify(call.arguments) !== JSON.stringify(step.arguments)
		) {
			throw new Error(`Behavior ${step.name} tool result/context mismatch`);
		}
	}
	return results;
}

function authResponse() {
	const text = "behavior-auth-ok";
	const item = {
		type: "message",
		id: "msg_behavior_auth",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp_behavior_auth", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text },
		{ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp_behavior_auth",
				object: "response",
				model: "gpt-4.1-mini",
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
			},
		},
	];
	const encoder = new TextEncoder();
	return new Response(new ReadableStream({
		start(controller) {
			for (const [sequence_number, event] of events.entries()) {
				controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`));
			}
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream", "x-request-id": "req_behavior_auth" } });
}

export default function (diffex) {
	const recordPath = process.env.DIFFEX_BEHAVIOR_RECORD;
	if (!recordPath) throw new Error("DIFFEX_BEHAVIOR_RECORD is required");
	const record = (value) => appendFileSync(recordPath, `${JSON.stringify(value)}\n`);
	diffex.on("agent_settled", () => { record({ type: "settled" }); });
	diffex.on("tool_result", (event) => { record({ ...event, type: "tool_result" }); });
	const transport = process.env.DIFFEX_BEHAVIOR_TRANSPORT === "1";
	const blocked = (details) => {
		record({ type: "blocked-network", ...details });
		throw new Error("Network disabled by behavior acceptance fixture");
	};
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		record({ type: "request", url, method });
		if (url === "https://api.diffex.ai/api/latest-version" && method === "GET") {
			return Response.json({ error: "no_published_release" }, { status: 404 });
		}
		if (!transport || url !== "https://api.openai.com/v1/responses" || method !== "POST") {
			return blocked({ transport: "fetch", url, method });
		}
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
		const allowedHeaders = new Set([
			"accept", "authorization", "content-type", "user-agent", "session_id", "x-client-request-id",
			"x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version",
			"x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-retry-count", "x-stainless-timeout",
		]);
		for (const name of headers.keys()) {
			if (!allowedHeaders.has(name)) return blocked({ transport: "fetch", url, header: name });
		}
		if (process.env.OPENAI_API_KEY !== "fake" || headers.get("authorization") !== "Bearer fake" || headers.get("content-type") !== "application/json") {
			return blocked({ transport: "fetch", url, reason: "Unexpected auth or content-type" });
		}
		const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
		if (typeof body !== "string") return blocked({ transport: "fetch", url, reason: "Expected JSON body" });
		const payload = JSON.parse(body);
		if (payload.model !== "gpt-4.1-mini" || payload.stream !== true || !Array.isArray(payload.input)) {
			return blocked({ transport: "fetch", url, reason: "Unexpected model or streaming payload" });
		}
		record({ type: "inference", provider: "openai", model: payload.model, transport: "fetch", credentialVerified: true });
		record({ type: "context", transport: "fetch", input: payload.input });
		record({ type: "auth-request", url, credentialVerified: true, headers: { ...Object.fromEntries(headers), authorization: "Bearer [fixture]" }, payload });
		return authResponse();
	};
	Socket.prototype.connect = function () {
		return blocked({ transport: "socket" });
	};
	syncBuiltinESMExports();
	// Crucially, transport mode does not register/override any provider or auth.
	if (transport) return;

	diffex.registerProvider("behavior", {
		baseUrl: "https://behavior.invalid",
		apiKey: "local-fixture",
		api: "behavior",
		models: [{
			id: "fixture",
			name: "Behavior fixture",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 1024,
		}],
		streamSimple(model, context, options = {}) {
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "pending", timestamp: Date.now(),
			};
			queueMicrotask(async () => {
				try {
					const messages = context.messages;
					const promptIndex = messages.findLastIndex((entry) => entry.role === "user");
					const prompt = promptIndex < 0 ? "" : textOf(messages[promptIndex]);
					const modes = prompt.match(/\bBEHAVIOR_(?:PRINT|TOOLS|CANCEL|RECOVER|RESUME)\b/g) ?? [];
					if (new Set(modes).size !== 1) throw new Error("Expected exactly one BEHAVIOR mode in latest user prompt");
					const mode = modes[0];
					record({ type: "inference", provider: model.provider, model: model.id, mode, prompt });
					record({ type: "context", mode, messages, tools: context.tools?.map((tool) => tool.name) ?? [] });
					for (const result of messages.filter((entry) => entry.role === "toolResult")) {
						record({ type: "tool-result", mode, ...result });
					}
					await options.onPayload?.({ model: model.id, messages }, model);
					await options.onResponse?.({ status: 200, headers: {} }, model);
					if (options.signal?.aborted) throw new Error("Request was aborted");
					stream.push({ type: "start", partial: message });
					let text;
					if (mode === "BEHAVIOR_TOOLS") {
						const results = checkedResults(messages, promptIndex);
						if (results.length < toolSteps.length) {
							const step = toolSteps[results.length];
							if (!context.tools?.some((tool) => tool.name === step.name)) throw new Error(`Missing built-in ${step.name} tool`);
							const call = { type: "toolCall", id: `behavior_${promptIndex}_${step.name}`, ...step };
							message.content.push(call);
							stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
							stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(step.arguments), partial: message });
							stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
							message.stopReason = "toolUse";
							stream.push({ type: "done", reason: "toolUse", message });
							stream.end(message);
							return;
						}
						text = "behavior-tools-ok";
					} else if (mode === "BEHAVIOR_RESUME") {
						const earlierIndex = messages.findLastIndex((entry, index) => index < promptIndex && entry.role === "user" && /\bBEHAVIOR_TOOLS\b/.test(textOf(entry)));
						if (earlierIndex < 0 || checkedResults(messages.slice(0, promptIndex), earlierIndex).length !== toolSteps.length || !messages.slice(earlierIndex + 1, promptIndex).some((entry) => entry.role === "assistant" && textOf(entry) === "behavior-tools-ok")) {
							throw new Error("Resumed context is missing the earlier BEHAVIOR_TOOLS prompt, results or final answer");
						}
						record({ type: "resume-verified", prompt: textOf(messages[earlierIndex]), toolNames: toolSteps.map((step) => step.name) });
						text = "behavior-resumed-ok";
					} else {
						text = { BEHAVIOR_PRINT: "behavior-print-ok", BEHAVIOR_RECOVER: "behavior-recovered-ok", BEHAVIOR_CANCEL: "behavior-cancel-started" }[mode];
					}
					message.content.push({ type: "text", text });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					if (mode === "BEHAVIOR_CANCEL") {
						if (!options.signal) throw new Error("Cancellation fixture requires an AbortSignal");
						record({ type: "cancel-started" });
						await new Promise((resolve) => {
							// Keep print/RPC processes alive as a real pending HTTP request would.
							const keepAlive = setInterval(() => {}, 1000);
							const abort = () => { clearInterval(keepAlive); resolve(); };
							options.signal.addEventListener("abort", abort, { once: true });
							if (options.signal.aborted) { options.signal.removeEventListener("abort", abort); abort(); }
						});
						record({ type: "abort", mode, aborted: options.signal.aborted });
						throw new Error("Behavior fixture request aborted");
					}
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
					message.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				} catch (error) {
					message.stopReason = options.signal?.aborted ? "aborted" : "error";
					message.errorMessage = error instanceof Error ? error.message : String(error);
					record({ type: "stream-error", reason: message.stopReason, message: message.errorMessage });
					stream.push({ type: "error", reason: message.stopReason, error: message });
					stream.end(message);
				}
			});
			return stream;
		},
	});
}
