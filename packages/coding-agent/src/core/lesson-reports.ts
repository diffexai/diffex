import type { AgentLoopConfig, StreamFn } from "@earendil-works/diffex-agent-core";
import type { AssistantMessage, Tool } from "@earendil-works/diffex-ai";
import type { HarnessVersion, HarnessVersionBundle } from "@earendil-works/diffex-harness-state";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { type EvolutionMemoryItem, type EvolutionMemoryWriter, parseEvolutionMemoryBlocks } from "#evolution";
import { createPrivateReportContinuation } from "./private-report.ts";

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
	/** Stable session/output-ordinal key captured before the main output. */
	getOutputId: () => string;
	writer: EvolutionMemoryWriter;
	/** Raw model-runtime transport, not the agent/extension-instrumented stream function. */
	stream: StreamFn;
	/** Private scoring boundary. */
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
		const outputId = options.getOutputId();
		// Start binding before the main output; never consult the selected pointer after this boundary.
		const catalog = options.writer.loadActiveMemoryItems(bundle).catch(() => undefined);
		return async (message, toolResults, signal) => {
			try {
				const activeMemoryItems = await catalog;
				if (!activeMemoryItems || activeMemoryItems.length !== lessonNumbers.length || signal?.aborted) return;
				await createPrivateReportContinuation({
					context,
					model,
					stream: options.stream,
					prompt: LESSON_REPORT_PROMPT,
					tool: LESSON_REPORT_TOOL,
					consume: async (response) => {
						const report = resolveLessonReport(
							response,
							{ outputId, harnessRevision, activeMemoryItems },
							lessonNumbers,
						);
						if (report) await options.consume?.(report);
					},
				})(message, toolResults, signal);
			} catch {
				// Missing, failed, or malformed reports are not empty reports and never surface to the user.
			}
		};
	};
}
