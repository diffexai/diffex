// Mounted into acceptance containers only; never included in an image layer.
import { appendFileSync } from "node:fs";
import { Socket } from "node:net";
import { ModelRuntime } from "/opt/diffex/packages/coding-agent/dist/index.js";
import { createAssistantMessageEventStream } from "/opt/diffex/packages/ai/dist/index.js";
import "/opt/diffex/packages/coding-agent/dist/core/http-dispatcher.js";

const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
	const options = Array.isArray(args[0]) ? args[0][0] : args[0];
	const host = typeof options === "object" ? options.host : args[1];
	if (host !== "127.0.0.1" && host !== "::1") throw new Error("Runtime smoke blocked external socket");
	return connect.apply(this, args);
};
globalThis.fetch = async (input) => {
	if (String(input) !== "http://127.0.0.1:1/usage") throw new Error("Runtime smoke blocked external fetch");
	appendFileSync(process.env.DIFFEX_SMOKE_EVENTS, "usage\n");
	return Response.json({ accepted: true });
};
const create = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (...args) => {
	const runtime = await create(...args);
	runtime.registerProvider("runtime-fixture", {
		baseUrl: "https://fixture.invalid",
		apiKey: "local-fixture",
		api: "runtime-fixture",
		models: [
			{
				id: "fixture",
				name: "Runtime fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 128,
			},
		],
		streamSimple(model) {
			appendFileSync(process.env.DIFFEX_SMOKE_EVENTS, "inference\n");
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "runtime-fixture-ok" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "runtime-fixture-ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		},
	});
	return runtime;
};
