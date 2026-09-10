import { Agent } from "@diffexai/diffex-agent-core";
import { createModels } from "@diffexai/diffex-ai";
import { anthropicProvider } from "@diffexai/diffex-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
