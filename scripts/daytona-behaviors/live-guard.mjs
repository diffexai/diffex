import { appendFileSync, existsSync, readFileSync } from "node:fs";

// Observes the installed provider transport; never supplies a model response.
export default function (diffex) {
	const record = (event) => appendFileSync(process.env.DIFFEX_BEHAVIOR_RECORD, `${JSON.stringify(event)}\n`);
	const originalFetch = globalThis.fetch;
	const started = Number(process.env.DIFFEX_BEHAVIOR_STARTED);
	let requests = existsSync(process.env.DIFFEX_BEHAVIOR_RECORD)
		? readFileSync(process.env.DIFFEX_BEHAVIOR_RECORD, "utf8").trim().split("\n").filter((line) => line && JSON.parse(line).type === "request").length
		: 0;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.href === "https://api.diffex.ai/api/latest-version")
			return Response.json({ error: "no_published_release" }, { status: 404 });
		if (url.origin !== "https://api.openai.com" || !url.pathname.startsWith("/v1/"))
			throw new Error("Unexpected live provider destination");
		if (++requests > 6 || Date.now() - started > 180_000) throw new Error("Live request budget exceeded");
		const body = JSON.parse(await request.text());
		if (url.pathname.endsWith("/responses")) body.max_output_tokens = 512;
		else body.max_completion_tokens = 512;
		record({ type: "request", request: requests, path: url.pathname, maxOutputTokens: 512 });
		try {
			const response = await originalFetch(new Request(request, {
				body: JSON.stringify(body), signal: AbortSignal.any([request.signal, AbortSignal.timeout(180_000 - (Date.now() - started))]),
			}));
			record({ type: "response", status: response.status });
			return response;
		} catch (error) {
			record({ type: "provider-error", error: error instanceof Error ? error.name : "UnknownError" });
			throw error;
		}
	};
	diffex.on("tool_result", (event) => record({ type: "tool_result", toolName: event.toolName, content: event.content, isError: event.isError }));
	diffex.on("message_update", (event) => {
		if (event.assistantMessageEvent.type === "text_delta") record({ type: "streamed-text", delta: event.assistantMessageEvent.delta });
	});
	diffex.on("agent_end", (event) => record({ type: "agent_end", messages: event.messages }));
	diffex.on("agent_settled", () => record({ type: "settled" }));
}
