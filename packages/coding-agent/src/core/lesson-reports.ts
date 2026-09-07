import type { AgentLoopConfig, StreamFn } from "@earendil-works/diffex-agent-core";
import { type AssistantMessage, type Tool, uuidv7 } from "@earendil-works/diffex-ai";
import type { HarnessVersion, HarnessVersionBundle } from "@earendil-works/diffex-harness-state";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/diffex-telemetry";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { type EvolutionMemoryItem, type EvolutionMemoryWriter, parseEvolutionMemoryBlocks } from "#evolution";

export const LESSON_REPORT_PROMPT =
	"From your evolution lessons, report only lessons you used during this run that were helpful or harmful. Return their lesson numbers and helpful/harmful judgments. Omit all other lessons; return an empty list if none qualify. Submit the report using report_lesson_usage.";

export const LESSON_REPORT_TOOL = {
	name: "report_lesson_usage",
	description: "Privately report only helpful or harmful evolution lessons used during this run.",
	parameters: Type.Object(
		{
			lessons: Type.Array(
				Type.Object(
					{
						lessonNumber: Type.Integer({ minimum: 1 }),
						signal: Type.Union([Type.Literal("helpful"), Type.Literal("harmful")]),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
} satisfies Tool;

/** Ephemeral input for scoring; never a session/evolution artifact. No neutral inference here. */
export interface ValidatedLessonReport {
	readonly outputId: string;
	readonly harnessRevision: HarnessVersion;
	readonly activeMemoryItems: readonly EvolutionMemoryItem[];
	readonly judgments: readonly {
		readonly item: EvolutionMemoryItem;
		readonly signal: "helpful" | "harmful";
	}[];
}

export function resolveLessonReport(
	message: AssistantMessage,
	binding: Omit<ValidatedLessonReport, "judgments">,
	lessonNumbers: readonly number[],
): ValidatedLessonReport | undefined {
	if (message.stopReason !== "toolUse") return undefined;
	const calls = message.content.filter((part) => part.type === "toolCall");
	const call = calls[0];
	if (calls.length !== 1 || call?.name !== LESSON_REPORT_TOOL.name) return undefined;
	if (!Check(LESSON_REPORT_TOOL.parameters, call.arguments)) return undefined;
	const seen = new Set<number>();
	const judgments: ValidatedLessonReport["judgments"][number][] = [];
	for (const entry of call.arguments.lessons) {
		const item = binding.activeMemoryItems[lessonNumbers.indexOf(entry.lessonNumber)];
		if (!item || seen.has(entry.lessonNumber)) return undefined;
		seen.add(entry.lessonNumber);
		judgments.push({ item, signal: entry.signal });
	}
	return { ...binding, judgments };
}

export function createLessonReportContinuation(options: {
	getBundle: () => HarnessVersionBundle | undefined;
	writer: EvolutionMemoryWriter;
	/** Raw model-runtime transport, not the agent/extension-instrumented stream function. */
	stream: StreamFn;
	/** Item 3's scoring boundary. Valid reports are otherwise consumed and discarded. */
	consume?: (report: ValidatedLessonReport) => Promise<void>;
}): NonNullable<AgentLoopConfig["preparePrivateContinuation"]> {
	return (context, model) => {
		const bundle = options.getBundle();
		if (!bundle?.state.memory) return undefined;
		const memory = `<evolution_memory version="${bundle.manifest.version}">\n${bundle.state.memory}\n</evolution_memory>`;
		if (!context.systemPrompt?.includes(memory)) return undefined;
		const lessonNumbers = parseEvolutionMemoryBlocks(bundle.state.memory).map((block) =>
			Number(/^Lesson ([1-9]\d*):/.exec(block.content)?.[1]),
		);
		if (
			lessonNumbers.some((number) => !Number.isSafeInteger(number)) ||
			new Set(lessonNumbers).size !== lessonNumbers.length
		) {
			return undefined;
		}
		const harnessRevision = bundle.manifest.version;
		const outputId = uuidv7();
		// Start binding before the main output; never consult the selected pointer after this boundary.
		const catalog = options.writer.loadActiveMemoryItems(bundle).catch(() => undefined);
		return async (message, toolResults, signal) => {
			try {
				const activeMemoryItems = await catalog;
				if (!activeMemoryItems || activeMemoryItems.length !== lessonNumbers.length || signal?.aborted) return;
				const deadline = AbortSignal.timeout(30_000);
				const privateSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
				const response = await options.stream(
					model,
					{
						systemPrompt: context.systemPrompt,
						messages: [
							...context.messages,
							...structuredClone([message, ...toolResults]),
							{ role: "user", content: LESSON_REPORT_PROMPT, timestamp: Date.now() },
						],
						tools: [LESSON_REPORT_TOOL],
					},
					{
						signal: privateSignal,
						telemetryContext: NOOP_TELEMETRY_CONTEXT,
						transport: "sse",
						cacheRetention: "none",
						maxTokens: 1024,
						timeoutMs: 30_000,
						maxRetries: 0,
					},
				);
				// Drain privately: no agent events, extension callbacks, or transcript writes.
				for await (const _event of response) {
					// Only the final response is eligible for validation.
				}
				const report = resolveLessonReport(
					await response.result(),
					{ outputId, harnessRevision, activeMemoryItems },
					lessonNumbers,
				);
				if (report && !privateSignal.aborted) await options.consume?.(report);
			} catch {
				// Missing, failed, or malformed reports are not empty reports and never surface to the user.
			}
		};
	};
}
