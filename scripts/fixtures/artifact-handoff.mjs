import { appendFileSync } from "node:fs";
import { Socket } from "node:net";
import { createAssistantMessageEventStream } from "@diffexai/diffex-ai";

export default function (diffex) {
  const record = (value) =>
    appendFileSync(
      process.env.DIFFEX_HANDOFF_RECORD,
      JSON.stringify(value) + "\n",
    );
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    record({ type: "request", url });
    if (url !== "https://api.diffex.ai/api/latest-version")
      throw new Error("Unexpected handoff request");
    return Response.json({ error: "no_published_release" }, { status: 404 });
  };
  Socket.prototype.connect = function () {
    record({ type: "blocked-network" });
    throw new Error("Network disabled by artifact acceptance");
  };
  diffex.registerProvider("handoff", {
    baseUrl: "https://provider.invalid",
    apiKey: "local-fixture",
    api: "handoff",
    models: [
      {
        id: "fixture",
        name: "Handoff fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
      },
    ],
    streamSimple: (model) => {
      record({ type: "inference", provider: model.provider });
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "handoff-fixture-ok" }],
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
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "handoff-fixture-ok",
          partial: message,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: "handoff-fixture-ok",
          partial: message,
        });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  });
}
