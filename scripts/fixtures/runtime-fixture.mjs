// Mounted into acceptance containers only; never included in an image layer.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import "/opt/diffex/packages/coding-agent/dist/core/http-dispatcher.js";

const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
	const options = Array.isArray(args[0]) ? args[0][0] : args[0];
	const host = typeof options === "object" ? options.host : args[1];
	if (host !== "127.0.0.1" && host !== "::1") throw new Error("Runtime smoke blocked external socket");
	return connect.apply(this, args);
};
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	if (request.url === "http://127.0.0.1:1/usage") {
		appendFileSync(process.env.DIFFEX_SMOKE_EVENTS, "usage\n");
		return Response.json({ accepted: true });
	}
	if (request.url !== `${process.env.DIFFEX_MODEL_GATEWAY_URL}/v1/messages`) {
		throw new Error("Runtime smoke blocked external fetch");
	}
	if (request.headers.get("x-api-key") !== "runtime-local-gateway-fixture") {
		throw new Error("Runtime smoke rejected gateway credential");
	}
	const operationId = request.headers.get("x-diffex-operation-id");
	const pending = join(process.env.DIFFEX_RUNTIME_STATE_DIR, "model-operations", `${operationId}.json`);
	if (!operationId || !existsSync(pending) || JSON.parse(readFileSync(pending, "utf8")).operationId !== operationId) {
		throw new Error("Runtime smoke did not persist its operation before inference");
	}
	appendFileSync(process.env.DIFFEX_SMOKE_EVENTS, "inference\n");
	const events = [
		{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant",
			model: process.env.DIFFEX_MODEL_ID, content: [], stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "runtime-fixture-ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
			usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } });
};
