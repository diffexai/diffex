import type {
	EvidenceCoverageEntry,
	EvidenceCoverageMap,
	EvidenceSlice,
	EvolutionArtifactMetadata,
	EvolutionArtifactProducer,
	EvolutionLedgerEvent,
	EvolutionReferenceNormalization,
	JsonObject,
	Lesson,
	LessonKind,
	ReflectionLeafRetryPendingLedgerEvent,
	ReflectionNode,
	ReflectionNodeCheckpointedLedgerEvent,
	ReflectionNodeFailure,
	ReflectionNodeRuntime,
	ReflectorModelCallLedgerEvent,
	ReflectorToolCallLedgerEvent,
} from "./contracts.ts";
import { EvolutionExecutionError } from "./errors.ts";
import { EvolutionModelReferenceCatalog, EvolutionModelReferenceError, referenceArray } from "./model-references.ts";
import type {
	EvolutionArtifact,
	EvolutionArtifactStore,
	EvolutionLedger,
	EvolutionModelResponse,
	ReflectionResult,
	Reflector,
	ReflectorInput,
} from "./ports.ts";
import { computeEvolutionContentDigest, createEvolutionArtifactMetadata } from "./provenance.ts";
import { type ReflectorNodeReferences, type ReflectorToolAudit, ReflectorToolRegistry } from "./reflector-tools.ts";

const DEFAULT_MAX_RECURSION_DEPTH = 8;
const DEFAULT_MAX_EVIDENCE_TOOL_CALLS_PER_LEAF = 6;
const DEFAULT_MAX_LESSON_TOOL_CALLS_PER_SYNTHESIS_NODE = 2;
const DEFAULT_MAX_LESSONS_PER_LEAF = 3;
const DEFAULT_MAX_UNITS_PER_SLICE = 64;
const DEFAULT_SYNTHESIS_FANOUT = 8;
const DEFAULT_MAX_LESSONS_PER_SYNTHESIS_NODE = 5;
const DEFAULT_MAX_CURATOR_LESSONS = 7;
const DEFAULT_NODE_DEADLINE_MS = 300_000;
const DEFAULT_STAGE_DEADLINE_MS = 1_800_000;

const LESSON_KINDS = new Set<LessonKind>([
	"counterexample",
	"direct-instruction",
	"failed-approach",
	"failure-workaround",
	"harmful-memory",
	"incorrect-source-of-truth",
	"missing-capability",
	"missing-verification",
	"orchestration-inefficiency",
	"repository-constraint",
	"successful-strategy",
	"tool-behavior",
	"unresolved-work",
]);

export interface RecursiveReflectorOptions {
	readonly maxToolCalls?: number;
	readonly maxModelCalls?: number;
	readonly maxRecursionDepth?: number;
	readonly maxEvidenceToolCallsPerLeaf?: number;
	readonly maxLessonToolCallsPerSynthesisNode?: number;
	readonly maxLessonsPerLeaf?: number;
	readonly maxLessonsPerSynthesisNode?: number;
	readonly maxUnitsPerSlice?: number;
	readonly synthesisFanout?: number;
	readonly maxCuratorLessons?: number;
	readonly nodeDeadlineMs?: number;
	readonly stageDeadlineMs?: number;
}

export interface RecursiveReflectorDependencies {
	readonly version: string;
	readonly artifacts: EvolutionArtifactStore;
	readonly ledger: EvolutionLedger;
}

interface NodePlan {
	readonly nodeId: string;
	readonly kind: "leaf" | "synthesis";
	readonly depth: number;
	parentNodeId: string | null;
	readonly childNodeIds: readonly string[];
	readonly sliceIds: readonly string[];
	readonly evidenceIds: readonly string[];
}

interface CompletedNode {
	readonly node: ReflectionNode;
	readonly lessons: readonly Lesson[];
}

interface RemainingReflectionBudget {
	readonly modelCalls: number;
	readonly toolCalls: number;
}

interface MutableAttemptConsumption {
	modelCalls: number;
	toolCalls: number;
}

interface MutableNodeRuntime {
	providerCalls: number;
	providerLatencyMs: number;
	internalToolRounds: number;
	outputTokens: number;
	retries: number;
	foregroundWaitMs: number;
	priorNodeDurationMs: number;
	readonly startedAt: number;
}

function nodeRuntime(runtime: MutableNodeRuntime): ReflectionNodeRuntime {
	return {
		providerCalls: runtime.providerCalls,
		providerLatencyMs: runtime.providerLatencyMs,
		internalToolRounds: runtime.internalToolRounds,
		outputTokens: runtime.outputTokens,
		retries: runtime.retries,
		foregroundWaitMs: runtime.foregroundWaitMs,
		nodeDurationMs: runtime.priorNodeDurationMs + performance.now() - runtime.startedAt,
	};
}

function newNodeRuntime(prior?: ReflectionNodeRuntime): MutableNodeRuntime {
	return {
		providerCalls: prior?.providerCalls ?? 0,
		providerLatencyMs: prior?.providerLatencyMs ?? 0,
		internalToolRounds: prior?.internalToolRounds ?? 0,
		outputTokens: prior?.outputTokens ?? 0,
		retries: prior?.retries ?? 0,
		foregroundWaitMs: prior?.foregroundWaitMs ?? 0,
		priorNodeDurationMs: prior?.nodeDurationMs ?? 0,
		startedAt: performance.now(),
	};
}

interface LessonDraft {
	readonly kind: LessonKind;
	readonly summary: string;
	readonly preconditions: readonly string[];
	readonly observedOutcome: string;
	readonly evidenceIds: readonly string[];
	readonly counterevidenceIds: readonly string[];
	readonly applicabilityBoundaries: readonly string[];
	readonly uncertainty: string | null;
	readonly actionableTakeaway: string;
	readonly sourceIds: readonly string[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
	return resolved;
}

function stableId(kind: string, value: unknown): string {
	return `${kind}-${computeEvolutionContentDigest(value).slice("sha256:".length, "sha256:".length + 32)}`;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function stringArray(value: unknown, name: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new Error(`${name} must be an array of non-empty strings`);
	}
	if (new Set(value).size !== value.length) throw new Error(`${name} must not contain duplicates`);
	return value;
}

function requiredString(record: Readonly<Record<string, unknown>>, name: string): string {
	const value = record[name];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
	return value;
}

function lessonContent(
	value: Readonly<Record<string, unknown>>,
): Omit<LessonDraft, "counterevidenceIds" | "evidenceIds" | "sourceIds"> {
	const kind = value.kind;
	if (typeof kind !== "string" || !LESSON_KINDS.has(kind as LessonKind)) {
		throw new Error(`Unsupported lesson kind "${String(kind)}"`);
	}
	const uncertainty = value.uncertainty;
	if (uncertainty !== null && typeof uncertainty !== "string") {
		throw new Error("uncertainty must be a string or null");
	}
	return {
		kind: kind as LessonKind,
		summary: requiredString(value, "summary"),
		preconditions: stringArray(value.preconditions, "preconditions"),
		observedOutcome: requiredString(value, "observedOutcome"),
		applicabilityBoundaries: stringArray(value.applicabilityBoundaries, "applicabilityBoundaries"),
		uncertainty,
		actionableTakeaway: requiredString(value, "actionableTakeaway"),
	};
}

function parseLeafLessonDraft(
	value: unknown,
	evidence: ReflectorNodeReferences["evidence"],
	normalizations: EvolutionReferenceNormalization[],
): LessonDraft {
	if (!isRecord(value)) throw new Error("lesson must be an object");
	const supporting = referenceArray(value.supportingEvidenceRefs, "supportingEvidenceRefs", evidence, {
		allowEmpty: false,
		normalizeBare: true,
		normalizations,
	});
	const counter = referenceArray(value.counterevidenceRefs, "counterevidenceRefs", evidence, {
		normalizeBare: true,
		normalizations,
	});
	const evidenceIds = supporting.map((entry) => entry.evidence.evidenceId);
	const counterevidenceIds = counter.map((entry) => entry.evidence.evidenceId);
	if (evidenceIds.length === 0) throw new Error("A lesson must cite supporting evidence");
	return {
		...lessonContent(value),
		evidenceIds,
		counterevidenceIds,
		sourceIds: unique([...evidenceIds, ...counterevidenceIds]),
	};
}

function parseSynthesisLessonDraft(value: unknown, lessons: EvolutionModelReferenceCatalog<Lesson>): LessonDraft {
	if (!isRecord(value)) throw new Error("lesson must be an object");
	const sources = referenceArray(value.sourceLessonRefs, "sourceLessonRefs", lessons, { allowEmpty: false });
	const counters = referenceArray(value.counterLessonRefs, "counterLessonRefs", lessons);
	const counterIds = new Set(counters.map((lesson) => lesson.lessonId));
	if (sources.some((lesson) => counterIds.has(lesson.lessonId))) {
		throw new EvolutionModelReferenceError(
			"counterLessonRefs",
			[],
			lessons.references,
			"must not overlap sourceLessonRefs",
		);
	}
	const evidenceIds = unique([
		...sources.flatMap((lesson) => lesson.evidenceIds),
		...counters.flatMap((lesson) => lesson.counterevidenceIds),
	]);
	const counterevidenceIds = unique([
		...sources.flatMap((lesson) => lesson.counterevidenceIds),
		...counters.flatMap((lesson) => lesson.evidenceIds),
	]);
	if (evidenceIds.length === 0) throw new Error("A synthesized lesson must retain supporting evidence");
	return {
		...lessonContent(value),
		evidenceIds,
		counterevidenceIds,
		sourceIds: unique([...sources, ...counters].map((lesson) => lesson.lessonId)),
	};
}

function parseResponse(
	response: EvolutionModelResponse,
	context:
		| { readonly kind: "leaf"; readonly evidence: ReflectorNodeReferences["evidence"] }
		| { readonly kind: "synthesis"; readonly lessons: EvolutionModelReferenceCatalog<Lesson> },
	maxLessons: number | undefined,
): {
	readonly complete: boolean;
	readonly lessons: readonly LessonDraft[];
	readonly referenceNormalizations: readonly EvolutionReferenceNormalization[];
} {
	if (response.output.complete !== true) {
		throw new Error("Reflector response complete must be true");
	}
	if (!Array.isArray(response.output.lessons)) throw new Error("Reflector response lessons must be an array");
	const referenceNormalizations: EvolutionReferenceNormalization[] = [];
	if (context.kind === "synthesis" && maxLessons !== undefined && response.output.lessons.length > maxLessons) {
		throw new Error(`Synthesis lesson set exceeds the node limit of ${maxLessons}`);
	}
	const lessons =
		context.kind === "leaf" && maxLessons !== undefined
			? response.output.lessons.slice(0, maxLessons)
			: response.output.lessons;
	return {
		complete: response.output.complete,
		lessons: lessons.map((lesson) =>
			context.kind === "leaf"
				? parseLeafLessonDraft(lesson, context.evidence, referenceNormalizations)
				: parseSynthesisLessonDraft(lesson, context.lessons),
		),
		referenceNormalizations,
	};
}

function reflectorOutputSchema(
	kind: "leaf" | "synthesis",
	references: readonly string[],
	maxLessons: number | undefined,
): JsonObject {
	const evidenceReferences = references.flatMap((reference) => [reference, reference.slice(1)]);
	const referenceProperties: JsonObject =
		kind === "leaf"
			? {
					supportingEvidenceRefs: {
						type: "array",
						minItems: 1,
						items: { type: "string", enum: evidenceReferences },
					},
					counterevidenceRefs: {
						type: "array",
						items: { type: "string", enum: evidenceReferences },
					},
				}
			: {
					sourceLessonRefs: {
						type: "array",
						minItems: 1,
						items: { type: "string", enum: references },
					},
					counterLessonRefs: {
						type: "array",
						items: { type: "string", enum: references },
					},
				};
	const referenceFields: readonly string[] =
		kind === "leaf" ? ["supportingEvidenceRefs", "counterevidenceRefs"] : ["sourceLessonRefs", "counterLessonRefs"];
	return {
		type: "object",
		additionalProperties: false,
		required: ["complete", "lessons"],
		properties: {
			complete: { enum: [true] },
			lessons: {
				type: "array",
				...(maxLessons === undefined ? {} : { maxItems: maxLessons }),
				items: {
					type: "object",
					additionalProperties: false,
					required: [
						"kind",
						"summary",
						"preconditions",
						"observedOutcome",
						...referenceFields,
						"applicabilityBoundaries",
						"uncertainty",
						"actionableTakeaway",
					],
					properties: {
						kind: { enum: [...LESSON_KINDS] },
						summary: { type: "string", minLength: 1 },
						preconditions: { type: "array", items: { type: "string", minLength: 1 } },
						observedOutcome: { type: "string", minLength: 1 },
						...referenceProperties,
						applicabilityBoundaries: {
							type: "array",
							items: { type: "string", minLength: 1 },
						},
						uncertainty: { type: ["string", "null"] },
						actionableTakeaway: { type: "string", minLength: 1 },
					},
				},
			},
		},
	};
}

function isReflectionNode(artifact: EvolutionArtifact): artifact is ReflectionNode {
	return "nodeId" in artifact;
}

function isLesson(artifact: EvolutionArtifact): artifact is Lesson {
	return "lessonId" in artifact;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

class ActiveComputeDeadline {
	readonly #controller = new AbortController();
	readonly #error: Error;
	#remainingMs: number;
	#activeSince = performance.now();
	#timer: ReturnType<typeof setTimeout> | null = null;
	#pauseDepth = 0;

	constructor(durationMs: number, label: string) {
		this.#remainingMs = durationMs;
		this.#error = new Error(`${label} active-compute deadline exceeded`);
		this.#error.name = "ActiveComputeDeadlineError";
		this.#arm();
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	get expired(): boolean {
		return this.#controller.signal.aborted;
	}

	pause(): void {
		this.#pauseDepth += 1;
		if (this.#pauseDepth !== 1 || this.expired) return;
		this.#remainingMs -= performance.now() - this.#activeSince;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}

	resume(): void {
		if (this.#pauseDepth === 0) return;
		this.#pauseDepth -= 1;
		if (this.#pauseDepth === 0 && !this.expired) this.#arm();
	}

	dispose(): void {
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}

	#arm(): void {
		this.#activeSince = performance.now();
		this.#timer = setTimeout(() => this.#controller.abort(this.#error), Math.max(0, this.#remainingMs));
	}
}

function combinedSignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
	return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}

async function runBounded<T>(
	values: readonly T[],
	concurrency: number,
	run: (value: T) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (nextIndex < values.length) {
			const value = values[nextIndex];
			nextIndex += 1;
			if (value !== undefined) await run(value);
		}
	});
	const results = await Promise.allSettled(workers);
	const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failure !== undefined) throw failure.reason;
}

export class RecursiveReflector implements Reflector {
	readonly #dependencies: RecursiveReflectorDependencies;
	readonly #maxToolCalls: number | null;
	readonly #maxModelCalls: number | null;
	readonly #maxRecursionDepth: number;
	readonly #maxEvidenceToolCallsPerLeaf: number;
	readonly #maxLessonToolCallsPerSynthesisNode: number;
	readonly #maxLessonsPerLeaf: number;
	readonly #maxLessonsPerSynthesisNode: number;
	readonly #maxUnitsPerSlice: number;
	readonly #synthesisFanout: number;
	readonly #maxCuratorLessons: number;
	readonly #nodeDeadlineMs: number;
	readonly #stageDeadlineMs: number;

	constructor(dependencies: RecursiveReflectorDependencies, options: RecursiveReflectorOptions = {}) {
		this.#dependencies = dependencies;
		this.#maxToolCalls =
			options.maxToolCalls === undefined ? null : positiveInteger(options.maxToolCalls, 1, "maxToolCalls");
		this.#maxModelCalls =
			options.maxModelCalls === undefined ? null : positiveInteger(options.maxModelCalls, 1, "maxModelCalls");
		this.#maxRecursionDepth = positiveInteger(
			options.maxRecursionDepth,
			DEFAULT_MAX_RECURSION_DEPTH,
			"maxRecursionDepth",
		);
		this.#maxEvidenceToolCallsPerLeaf = positiveInteger(
			options.maxEvidenceToolCallsPerLeaf,
			DEFAULT_MAX_EVIDENCE_TOOL_CALLS_PER_LEAF,
			"maxEvidenceToolCallsPerLeaf",
		);
		this.#maxLessonToolCallsPerSynthesisNode = positiveInteger(
			options.maxLessonToolCallsPerSynthesisNode,
			DEFAULT_MAX_LESSON_TOOL_CALLS_PER_SYNTHESIS_NODE,
			"maxLessonToolCallsPerSynthesisNode",
		);
		this.#maxLessonsPerLeaf = positiveInteger(
			options.maxLessonsPerLeaf,
			DEFAULT_MAX_LESSONS_PER_LEAF,
			"maxLessonsPerLeaf",
		);
		this.#maxLessonsPerSynthesisNode = positiveInteger(
			options.maxLessonsPerSynthesisNode,
			DEFAULT_MAX_LESSONS_PER_SYNTHESIS_NODE,
			"maxLessonsPerSynthesisNode",
		);
		this.#maxUnitsPerSlice = positiveInteger(
			options.maxUnitsPerSlice,
			DEFAULT_MAX_UNITS_PER_SLICE,
			"maxUnitsPerSlice",
		);
		this.#synthesisFanout = positiveInteger(options.synthesisFanout, DEFAULT_SYNTHESIS_FANOUT, "synthesisFanout");
		if (this.#synthesisFanout < 2) throw new Error("synthesisFanout must be at least 2");
		this.#maxCuratorLessons = positiveInteger(
			options.maxCuratorLessons,
			DEFAULT_MAX_CURATOR_LESSONS,
			"maxCuratorLessons",
		);
		this.#nodeDeadlineMs = positiveInteger(options.nodeDeadlineMs, DEFAULT_NODE_DEADLINE_MS, "nodeDeadlineMs");
		this.#stageDeadlineMs = positiveInteger(options.stageDeadlineMs, DEFAULT_STAGE_DEADLINE_MS, "stageDeadlineMs");
	}

	async reflect(input: ReflectorInput): Promise<ReflectionResult> {
		input.signal?.throwIfAborted();
		const stageDeadline = new ActiveComputeDeadline(this.#stageDeadlineMs, "Reflector stage");
		const stageSignal = combinedSignal(input.signal, stageDeadline.signal);
		const priorEvents = await this.#dependencies.ledger.read(input.jobId);
		const priorToolCalls = priorEvents.filter((event) => event.type === "reflector-tool-call").length;
		const priorModelCalls = priorEvents.filter((event) => event.type === "reflector-model-call").length;
		const providerCallAllowance = positiveInteger(
			input.model.maxProviderCallsPerExecution,
			1,
			"maxProviderCallsPerExecution",
		);
		const producer: EvolutionArtifactProducer = {
			name: "diffex-evolution-reflector",
			version: this.#dependencies.version,
			promptVersion: input.input.promptVersions.reflector,
			model: input.input.modelConfiguration,
		};
		const registry = new ReflectorToolRegistry({
			jobId: input.jobId,
			input: input.input,
			corpus: input.corpus,
			maxToolCalls: Number.MAX_SAFE_INTEGER,
			signal: stageSignal,
			audit: (audit) => this.#auditTool(input, producer, audit),
		});
		const onAbort = () => registry.revoke();
		stageSignal.addEventListener("abort", onAbort, { once: true });
		try {
			const slices = registry.planInitialSlices(this.#maxUnitsPerSlice);
			const plans = this.#buildPlan(input, slices);
			const completed = await this.#loadCompleted(input, plans, priorEvents);
			const retryPending = this.#loadRetryPending(input, plans, priorEvents, completed);
			const attemptConsumption = new Map<string, MutableAttemptConsumption>();
			let modelCalls = priorModelCalls;
			let effectiveModelCallLimit = priorModelCalls;
			const refreshBudgetEnvelope = () => {
				const remaining = this.#remainingBudget(
					plans,
					completed,
					retryPending,
					attemptConsumption,
					providerCallAllowance,
				);
				const toolCalls = priorToolCalls + registry.toolCalls;
				this.#assertBudgetFits(remaining, modelCalls, toolCalls);
				effectiveModelCallLimit = this.#maxModelCalls ?? modelCalls + remaining.modelCalls;
				const effectiveToolCallLimit = this.#maxToolCalls ?? toolCalls + remaining.toolCalls;
				registry.setMaxToolCalls(Math.max(registry.toolCalls, effectiveToolCallLimit - priorToolCalls));
			};
			refreshBudgetEnvelope();
			const executePlan = async (plan: NodePlan) => {
				if (stageDeadline.expired) {
					throw new EvolutionExecutionError("Reflector stage active-compute deadline was exhausted", {
						reasonCode: "reflection-budget-exhausted",
						retryable: true,
						cause: stageDeadline.signal.reason,
					});
				}
				if (completed.has(plan.nodeId)) return;
				const unavailableChildNodeIds = plan.childNodeIds.filter(
					(nodeId) => completed.get(nodeId)?.node.status !== "complete",
				);
				const childLessons = plan.childNodeIds.flatMap((nodeId) => {
					const child = completed.get(nodeId);
					return child?.node.status === "complete" ? child.lessons : [];
				});
				if (plan.kind === "synthesis" && childLessons.length === 0) {
					completed.set(
						plan.nodeId,
						unavailableChildNodeIds.length === 0
							? await this.#checkpointEmptySynthesis(input, producer, plan, unavailableChildNodeIds)
							: await this.#checkpointUnavailable(
									input,
									producer,
									plan,
									"failed",
									{
										diagnosticCode: "child-nodes-unavailable",
										message: "All child reflection lessons are unavailable",
									},
									newNodeRuntime(),
								),
					);
					refreshBudgetEnvelope();
					return;
				}
				const pending = retryPending.get(plan.nodeId);
				let nodeAttempt = pending === undefined ? 1 : 2;
				let runtime = newNodeRuntime(pending?.runtime);
				let result: CompletedNode;
				while (true) {
					const priorAttemptModelCalls = priorEvents.filter(
						(event) =>
							event.type === "reflector-model-call" &&
							event.nodeId === plan.nodeId &&
							event.attempt === nodeAttempt,
					).length;
					runtime.providerCalls += priorAttemptModelCalls;
					const consumption = { modelCalls: priorAttemptModelCalls, toolCalls: 0 };
					attemptConsumption.set(plan.nodeId, consumption);
					const nodeDeadline = new ActiveComputeDeadline(
						this.#nodeDeadlineMs,
						`Reflection node ${plan.nodeId} attempt ${nodeAttempt}`,
					);
					const attemptController = new AbortController();
					try {
						result = await this.#executeNode(
							{ ...input, signal: combinedSignal(stageSignal, nodeDeadline.signal, attemptController.signal) },
							producer,
							registry,
							plan,
							completed,
							unavailableChildNodeIds,
							nodeAttempt,
							priorAttemptModelCalls,
							() => {
								if (modelCalls >= effectiveModelCallLimit) {
									throw new EvolutionExecutionError("Reflector model-call budget is exhausted", {
										reasonCode: "reflection-budget-exhausted",
										retryable: false,
									});
								}
								modelCalls += 1;
							},
							stageDeadline,
							nodeDeadline,
							runtime,
							consumption,
						);
						break;
					} catch (error) {
						input.signal?.throwIfAborted();
						if (stageDeadline.expired) {
							throw new EvolutionExecutionError("Reflector stage active-compute deadline was exhausted", {
								reasonCode: "reflection-budget-exhausted",
								retryable: true,
								cause: error,
							});
						}
						const timedOut = nodeDeadline.expired;
						const failure = this.#nodeFailure(error, timedOut);
						if (plan.kind === "leaf" && nodeAttempt === 1 && (timedOut || this.#isRetryableLeafFailure(error))) {
							const retry = await this.#checkpointRetryPending(input, producer, plan, failure, runtime);
							attemptConsumption.delete(plan.nodeId);
							retryPending.set(plan.nodeId, retry);
							refreshBudgetEnvelope();
							runtime = newNodeRuntime(retry.runtime);
							nodeAttempt = 2;
							continue;
						}
						if (plan.kind === "leaf" && !timedOut && !this.#isRetryableLeafFailure(error)) throw error;
						if (plan.kind === "leaf") {
							result = await this.#checkpointUnavailable(
								input,
								producer,
								plan,
								timedOut ? "timed-out" : "failed",
								failure,
								runtime,
							);
							break;
						}
						if (!timedOut) throw error;
						result = await this.#checkpointUnavailable(input, producer, plan, "timed-out", failure, runtime);
						break;
					} finally {
						attemptController.abort(new Error(`Reflection node ${plan.nodeId} attempt ended`));
						nodeDeadline.dispose();
					}
				}
				attemptConsumption.delete(plan.nodeId);
				completed.set(plan.nodeId, result);
				refreshBudgetEnvelope();
			};
			await runBounded(
				plans.filter((plan) => plan.kind === "leaf"),
				2,
				executePlan,
			);
			for (const plan of plans) {
				if (plan.kind === "synthesis") await executePlan(plan);
			}
			const nodes = plans
				.map((plan) => completed.get(plan.nodeId)?.node)
				.filter((node): node is ReflectionNode => node !== undefined);
			const lessons = plans.flatMap((plan) => completed.get(plan.nodeId)?.lessons ?? []);
			const rootPlans = plans.filter((plan) => plan.parentNodeId === null);
			const unavailableRootNodeIds = rootPlans
				.filter((plan) => completed.get(plan.nodeId)?.node.status !== "complete")
				.map((plan) => plan.nodeId);
			if (unavailableRootNodeIds.length > 0) {
				throw new EvolutionExecutionError("Reflector root is unavailable", {
					reasonCode: "model-call-failed",
					retryable: true,
					diagnostics: { unavailableRootNodeIds },
				});
			}
			const finalLessonIds = rootPlans.flatMap(
				(plan) => completed.get(plan.nodeId)?.lessons.map((lesson) => lesson.lessonId) ?? [],
			);
			const coverage = this.#coverage(input, producer, registry.slices, rootPlans, finalLessonIds, completed);
			return { nodes, lessons, coverage, finalLessonIds };
		} finally {
			stageDeadline.dispose();
			registry.revoke();
			stageSignal.removeEventListener("abort", onAbort);
		}
	}

	#buildPlan(input: ReflectorInput, slices: readonly EvidenceSlice[]): readonly NodePlan[] {
		const plans: NodePlan[] = slices.map((slice) => ({
			nodeId: stableId("reflection-node", {
				idempotencyKey: input.idempotencyKey,
				kind: "leaf",
				sliceId: slice.sliceId,
			}),
			kind: "leaf",
			depth: 0,
			parentNodeId: null,
			childNodeIds: [],
			sliceIds: [slice.sliceId],
			evidenceIds: slice.evidenceIds,
		}));
		let layer = [...plans];
		let depth = 1;
		while (layer.length > 1) {
			if (depth > this.#maxRecursionDepth) {
				throw new EvolutionExecutionError("Reflector recursion-depth budget is exhausted", {
					reasonCode: "reflection-budget-exhausted",
					retryable: false,
				});
			}
			const parents: NodePlan[] = [];
			for (let index = 0; index < layer.length; index += this.#synthesisFanout) {
				const children = layer.slice(index, index + this.#synthesisFanout);
				const parent: NodePlan = {
					nodeId: stableId("reflection-node", {
						idempotencyKey: input.idempotencyKey,
						kind: "synthesis",
						childNodeIds: children.map((child) => child.nodeId),
					}),
					kind: "synthesis",
					depth,
					parentNodeId: null,
					childNodeIds: children.map((child) => child.nodeId),
					sliceIds: unique(children.flatMap((child) => child.sliceIds)),
					evidenceIds: unique(children.flatMap((child) => child.evidenceIds)),
				};
				for (const child of children) child.parentNodeId = parent.nodeId;
				parents.push(parent);
			}
			plans.push(...parents);
			layer = parents;
			depth += 1;
		}
		return plans;
	}

	#remainingBudget(
		plans: readonly NodePlan[],
		completed: ReadonlyMap<string, CompletedNode>,
		retryPending: ReadonlyMap<string, ReflectionLeafRetryPendingLedgerEvent>,
		attemptConsumption: ReadonlyMap<string, MutableAttemptConsumption>,
		providerCallAllowance: number,
	): RemainingReflectionBudget {
		let modelCalls = 0;
		let toolCalls = 0;
		for (const plan of plans) {
			if (completed.has(plan.nodeId)) continue;
			let conversations: number;
			let toolCallAllowance: number;
			if (plan.kind === "leaf") {
				conversations = retryPending.has(plan.nodeId) ? 1 : 2;
				toolCallAllowance = this.#maxEvidenceToolCallsPerLeaf;
			} else {
				const childrenTerminal = plan.childNodeIds.every((nodeId) => completed.has(nodeId));
				const hasSuccessfulChildLessons = plan.childNodeIds.some(
					(nodeId) => (completed.get(nodeId)?.lessons.length ?? 0) > 0,
				);
				conversations = childrenTerminal && !hasSuccessfulChildLessons ? 0 : 1;
				toolCallAllowance = this.#maxLessonToolCallsPerSynthesisNode;
			}
			const consumption = attemptConsumption.get(plan.nodeId);
			modelCalls += Math.max(0, conversations * providerCallAllowance - (consumption?.modelCalls ?? 0));
			toolCalls += Math.max(0, conversations * toolCallAllowance - (consumption?.toolCalls ?? 0));
			if (!Number.isSafeInteger(modelCalls) || !Number.isSafeInteger(toolCalls)) {
				throw new EvolutionExecutionError("Reflector remaining-plan budget exceeds safe integer limits", {
					reasonCode: "reflection-budget-exhausted",
					retryable: false,
				});
			}
		}
		return { modelCalls, toolCalls };
	}

	#assertBudgetFits(remaining: RemainingReflectionBudget, modelCalls: number, toolCalls: number): void {
		const availableModelCalls =
			this.#maxModelCalls === null ? remaining.modelCalls : Math.max(0, this.#maxModelCalls - modelCalls);
		const availableToolCalls =
			this.#maxToolCalls === null ? remaining.toolCalls : Math.max(0, this.#maxToolCalls - toolCalls);
		if (availableModelCalls >= remaining.modelCalls && availableToolCalls >= remaining.toolCalls) return;
		throw new EvolutionExecutionError(
			`Reflector remaining plan requires ${remaining.modelCalls} model calls and ${remaining.toolCalls} tool calls, but only ${availableModelCalls} model calls and ${availableToolCalls} tool calls are available`,
			{
				reasonCode: "reflection-budget-exhausted",
				retryable: false,
				diagnostics: {
					required: { modelCalls: remaining.modelCalls, toolCalls: remaining.toolCalls },
					available: { modelCalls: availableModelCalls, toolCalls: availableToolCalls },
					consumed: { modelCalls, toolCalls },
					ceilings: { modelCalls: this.#maxModelCalls, toolCalls: this.#maxToolCalls },
				},
			},
		);
	}

	async #loadCompleted(
		input: ReflectorInput,
		plans: readonly NodePlan[],
		events: readonly EvolutionLedgerEvent[],
	): Promise<Map<string, CompletedNode>> {
		const planIds = new Set(plans.map((plan) => plan.nodeId));
		const result = new Map<string, CompletedNode>();
		for (const event of events) {
			if (
				event.type !== "reflection-node-checkpointed" ||
				event.manifestDigest !== input.corpus.metadata.contentDigest ||
				!planIds.has(event.nodeId) ||
				result.has(event.nodeId)
			) {
				continue;
			}
			const nodeArtifact = await this.#dependencies.artifacts.get(event.node);
			if (
				!isReflectionNode(nodeArtifact) ||
				nodeArtifact.nodeId !== event.nodeId ||
				(nodeArtifact.status !== "complete" &&
					nodeArtifact.status !== "failed" &&
					nodeArtifact.status !== "timed-out")
			) {
				throw new EvolutionExecutionError(`Reflection checkpoint "${event.nodeId}" is corrupt`, {
					reasonCode: "artifact-corrupt",
					retryable: false,
				});
			}
			const lessons: Lesson[] = [];
			for (const reference of event.lessons) {
				const artifact = await this.#dependencies.artifacts.get(reference);
				if (!isLesson(artifact) || !nodeArtifact.lessonIds.includes(artifact.lessonId)) {
					throw new EvolutionExecutionError(`Reflection lesson checkpoint for "${event.nodeId}" is corrupt`, {
						reasonCode: "artifact-corrupt",
						retryable: false,
					});
				}
				lessons.push(artifact);
			}
			if (
				lessons.length !== nodeArtifact.lessonIds.length ||
				(nodeArtifact.status !== "complete" && lessons.length > 0)
			) {
				throw new EvolutionExecutionError(`Reflection checkpoint "${event.nodeId}" is incomplete`, {
					reasonCode: "artifact-corrupt",
					retryable: false,
				});
			}
			result.set(event.nodeId, { node: nodeArtifact, lessons });
		}
		return result;
	}

	#loadRetryPending(
		input: ReflectorInput,
		plans: readonly NodePlan[],
		events: readonly EvolutionLedgerEvent[],
		completed: ReadonlyMap<string, CompletedNode>,
	): Map<string, ReflectionLeafRetryPendingLedgerEvent> {
		const leafIds = new Set(plans.filter((plan) => plan.kind === "leaf").map((plan) => plan.nodeId));
		const result = new Map<string, ReflectionLeafRetryPendingLedgerEvent>();
		for (const event of events) {
			if (
				event.type === "reflection-leaf-retry-pending" &&
				event.manifestDigest === input.corpus.metadata.contentDigest &&
				leafIds.has(event.nodeId) &&
				!completed.has(event.nodeId)
			) {
				result.set(event.nodeId, event);
			}
		}
		return result;
	}

	async #executeNode(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		registry: ReflectorToolRegistry,
		plan: NodePlan,
		completed: ReadonlyMap<string, CompletedNode>,
		unavailableChildNodeIds: readonly string[],
		nodeAttempt: number,
		priorAttemptModelCalls: number,
		chargeModelCall: () => void,
		stageDeadline: ActiveComputeDeadline,
		nodeDeadline: ActiveComputeDeadline,
		runtime: MutableNodeRuntime,
		consumption: MutableAttemptConsumption,
	): Promise<CompletedNode> {
		const nodeReferences = registry.nodeReferences(plan.evidenceIds);
		const childLessons = plan.childNodeIds.flatMap((nodeId) => completed.get(nodeId)?.lessons ?? []);
		const lessonReferences = new EvolutionModelReferenceCatalog("lesson", childLessons);
		const chargeToolCall = () => {
			consumption.toolCalls += 1;
		};
		const tools =
			plan.kind === "leaf"
				? registry.toolsForEvidence(nodeReferences, this.#maxEvidenceToolCallsPerLeaf, input.signal, chargeToolCall)
				: registry.toolsForLessons(
						lessonReferences,
						this.#maxLessonToolCallsPerSynthesisNode,
						input.signal,
						chargeToolCall,
					);
		const maxLessons =
			plan.kind === "leaf"
				? this.#maxLessonsPerLeaf
				: plan.parentNodeId === null
					? this.#maxCuratorLessons
					: this.#maxLessonsPerSynthesisNode;
		const outputSchema = reflectorOutputSchema(
			plan.kind,
			plan.kind === "leaf" ? nodeReferences.evidence.references : lessonReferences.references,
			maxLessons,
		);
		const denialStart = registry.recoverableDenials.length;
		let providerCallHookInvoked = false;
		let providerCalls = 0;
		let nodeModelCallSequence = priorAttemptModelCalls;
		const beforeProviderCall = async () => {
			providerCallHookInvoked = true;
			chargeModelCall();
			consumption.modelCalls += 1;
			providerCalls += 1;
			runtime.providerCalls += 1;
			nodeModelCallSequence += 1;
			const modelCallId = stableId("reflector-model-call", {
				idempotencyKey: input.idempotencyKey,
				nodeId: plan.nodeId,
				nodeAttempt,
				nodeModelCallSequence,
			});
			await this.#dependencies.ledger.append(
				this.#modelCallEvent(input, producer, modelCallId, plan.nodeId, nodeAttempt, nodeModelCallSequence),
			);
		};
		let response: EvolutionModelResponse;
		try {
			response = await abortable(
				input.model.execute({
					stage: "reflector",
					model: input.input.modelConfiguration,
					promptVersion: input.input.promptVersions.reflector,
					idempotencyKey: `${input.idempotencyKey}:${plan.nodeId}:attempt-${nodeAttempt}`,
					input: this.#modelInput(input, plan, nodeReferences, lessonReferences, unavailableChildNodeIds),
					outputSchema,
					tools,
					validateOutput: (output) => {
						parseResponse(
							{ output, model: { provider: "validation", model: "validation" } },
							plan.kind === "leaf"
								? { kind: "leaf", evidence: nodeReferences.evidence }
								: { kind: "synthesis", lessons: lessonReferences },
							maxLessons,
						);
					},
					beforeProviderCall,
					onProviderCallComplete: (metrics) => {
						runtime.providerLatencyMs += metrics.durationMs;
						runtime.outputTokens += metrics.outputTokens;
						if (metrics.retry) runtime.retries += 1;
					},
					onInternalToolRound: () => {
						runtime.internalToolRounds += 1;
					},
					onForegroundWaitStart: () => {
						stageDeadline.pause();
						nodeDeadline.pause();
					},
					onForegroundWaitEnd: (durationMs) => {
						runtime.foregroundWaitMs += durationMs;
						nodeDeadline.resume();
						stageDeadline.resume();
					},
					signal: input.signal,
				}),
				input.signal,
			);
			if (providerCalls === 0) await beforeProviderCall();
		} catch (error) {
			input.signal?.throwIfAborted();
			if (!providerCallHookInvoked) await beforeProviderCall();
			if (error instanceof EvolutionExecutionError) throw error;
			throw new EvolutionExecutionError(`Reflector model call failed for "${plan.nodeId}"`, {
				reasonCode: "model-call-failed",
				retryable: true,
				cause: error,
				diagnostics: {
					nodeId: plan.nodeId,
					nodeAttempt,
					recoverableToolDenials: registry.recoverableDenials.slice(denialStart).map((denial) => ({
						toolName: denial.toolName,
						denialCode: denial.denialCode,
						requestedDocumentRef: denial.requestedDocumentRef,
						requestedSliceRef: denial.requestedSliceRef,
					})),
				},
			});
		}
		if (registry.budgetExhausted || registry.toolBudgetExhausted(tools)) {
			throw new EvolutionExecutionError("Reflector tool-call budget is exhausted", {
				reasonCode: "reflection-budget-exhausted",
				retryable: false,
			});
		}
		let parsed: ReturnType<typeof parseResponse>;
		try {
			parsed = parseResponse(
				response,
				plan.kind === "leaf"
					? { kind: "leaf", evidence: nodeReferences.evidence }
					: { kind: "synthesis", lessons: lessonReferences },
				maxLessons,
			);
		} catch (error) {
			const invalidReferences = error instanceof EvolutionModelReferenceError ? error.invalidReferences : [];
			const permittedReferences = error instanceof EvolutionModelReferenceError ? error.permittedReferences : [];
			throw new EvolutionExecutionError(`Reflector returned an invalid response for "${plan.nodeId}"`, {
				reasonCode: "reflection-invalid-response",
				retryable: false,
				cause: error,
				diagnostics: {
					nodeId: plan.nodeId,
					nodeAttempt,
					invalidAliases: invalidReferences,
					permittedAliases: permittedReferences,
					submissionMethod: response.submissionMethod ?? "unspecified",
					output: response.output,
				},
			});
		}
		const modelProducer: EvolutionArtifactProducer = {
			...producer,
			model: {
				provider: response.model.provider,
				model: response.model.model,
				configurationDigest: input.input.modelConfiguration.configurationDigest,
			},
		};
		const lessons = parsed.lessons.map((draft, index): Lesson => {
			const lessonId = stableId("lesson", { nodeId: plan.nodeId, index, draft });
			const { sourceIds, ...lessonContent } = draft;
			const content = { lessonId, ...lessonContent, scope: input.input.metadata.scope };
			return {
				metadata: this.#metadata(input, modelProducer, lessonId, sourceIds, content),
				lessonId,
				kind: draft.kind,
				summary: draft.summary,
				preconditions: draft.preconditions,
				observedOutcome: draft.observedOutcome,
				evidenceIds: draft.evidenceIds,
				counterevidenceIds: draft.counterevidenceIds,
				scope: input.input.metadata.scope,
				applicabilityBoundaries: draft.applicabilityBoundaries,
				uncertainty: draft.uncertainty,
				actionableTakeaway: draft.actionableTakeaway,
			};
		});
		const resultDigest = computeEvolutionContentDigest(response.output);
		const nodeContent = {
			nodeId: plan.nodeId,
			kind: plan.kind,
			depth: plan.depth,
			parentNodeId: plan.parentNodeId,
			childNodeIds: plan.childNodeIds,
			sliceIds: plan.sliceIds,
			evidenceIds: plan.evidenceIds,
			lessonIds: lessons.map((lesson) => lesson.lessonId),
			resultDigest,
			status: "complete" as const,
			runtime: nodeRuntime(runtime),
		};
		const node: ReflectionNode = {
			metadata: this.#metadata(input, modelProducer, plan.nodeId, plan.evidenceIds, nodeContent),
			...nodeContent,
		};
		const lessonArtifactReferences = await Promise.all(
			lessons.map((lesson) => this.#dependencies.artifacts.put(lesson)),
		);
		const nodeReference = await this.#dependencies.artifacts.put(node);
		const checkpointId = stableId("ledger-event", {
			jobId: input.jobId,
			type: "reflection-node-checkpointed",
			nodeId: node.nodeId,
			manifestDigest: input.corpus.metadata.contentDigest,
		});
		const checkpointContent = {
			nodeId: node.nodeId,
			manifestDigest: input.corpus.metadata.contentDigest,
			node: nodeReference,
			lessons: lessonArtifactReferences,
			referenceNormalizations: parsed.referenceNormalizations,
		};
		const checkpoint: ReflectionNodeCheckpointedLedgerEvent = {
			metadata: this.#metadata(input, producer, checkpointId, [node.nodeId], checkpointContent),
			eventId: checkpointId,
			jobId: input.jobId,
			type: "reflection-node-checkpointed",
			...checkpointContent,
		};
		await this.#dependencies.ledger.append(checkpoint);
		return { node, lessons };
	}

	#nodeFailure(error: unknown, timedOut: boolean): ReflectionNodeFailure {
		if (timedOut) {
			return {
				diagnosticCode: "node-timeout",
				message: error instanceof Error ? error.message : "Reflection node execution timed out",
			};
		}
		return {
			diagnosticCode: error instanceof EvolutionExecutionError ? error.reasonCode : "model-call-failed",
			message: error instanceof Error ? error.message : String(error),
		};
	}

	#isRetryableLeafFailure(error: unknown): boolean {
		return (
			error instanceof EvolutionExecutionError &&
			(error.reasonCode === "model-call-failed" || error.reasonCode === "reflection-invalid-response")
		);
	}

	async #checkpointRetryPending(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		plan: NodePlan,
		failure: ReflectionNodeFailure,
		runtime: MutableNodeRuntime,
	): Promise<ReflectionLeafRetryPendingLedgerEvent> {
		const content = {
			nodeId: plan.nodeId,
			manifestDigest: input.corpus.metadata.contentDigest,
			failure,
			runtime: nodeRuntime(runtime),
		};
		const eventId = stableId("ledger-event", {
			jobId: input.jobId,
			type: "reflection-leaf-retry-pending",
			nodeId: plan.nodeId,
			manifestDigest: input.corpus.metadata.contentDigest,
		});
		const event: ReflectionLeafRetryPendingLedgerEvent = {
			metadata: this.#metadata(input, producer, eventId, [plan.nodeId], content),
			eventId,
			jobId: input.jobId,
			type: "reflection-leaf-retry-pending",
			...content,
		};
		await this.#dependencies.ledger.append(event);
		return event;
	}

	async #checkpointUnavailable(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		plan: NodePlan,
		status: "failed" | "timed-out",
		failure: ReflectionNodeFailure,
		runtime: MutableNodeRuntime,
	): Promise<CompletedNode> {
		const nodeContent = {
			nodeId: plan.nodeId,
			kind: plan.kind,
			depth: plan.depth,
			parentNodeId: plan.parentNodeId,
			childNodeIds: plan.childNodeIds,
			sliceIds: plan.sliceIds,
			evidenceIds: plan.evidenceIds,
			lessonIds: [],
			resultDigest: computeEvolutionContentDigest({ status, failure }),
			status,
			failure,
			runtime: nodeRuntime(runtime),
		};
		const node: ReflectionNode = {
			metadata: this.#metadata(input, producer, plan.nodeId, plan.evidenceIds, nodeContent),
			...nodeContent,
		};
		const nodeReference = await this.#dependencies.artifacts.put(node);
		const checkpointId = stableId("ledger-event", {
			jobId: input.jobId,
			type: "reflection-node-checkpointed",
			nodeId: node.nodeId,
			manifestDigest: input.corpus.metadata.contentDigest,
		});
		const checkpointContent = {
			nodeId: node.nodeId,
			manifestDigest: input.corpus.metadata.contentDigest,
			node: nodeReference,
			lessons: [],
			referenceNormalizations: [],
		};
		await this.#dependencies.ledger.append({
			metadata: this.#metadata(input, producer, checkpointId, [node.nodeId], checkpointContent),
			eventId: checkpointId,
			jobId: input.jobId,
			type: "reflection-node-checkpointed",
			...checkpointContent,
		});
		return { node, lessons: [] };
	}

	async #checkpointEmptySynthesis(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		plan: NodePlan,
		unavailableChildNodeIds: readonly string[],
	): Promise<CompletedNode> {
		const nodeContent = {
			nodeId: plan.nodeId,
			kind: plan.kind,
			depth: plan.depth,
			parentNodeId: plan.parentNodeId,
			childNodeIds: plan.childNodeIds,
			sliceIds: plan.sliceIds,
			evidenceIds: plan.evidenceIds,
			lessonIds: [],
			resultDigest: computeEvolutionContentDigest({ empty: true, unavailableChildNodeIds }),
			status: "complete" as const,
			runtime: nodeRuntime(newNodeRuntime()),
		};
		const node: ReflectionNode = {
			metadata: this.#metadata(input, producer, plan.nodeId, plan.evidenceIds, nodeContent),
			...nodeContent,
		};
		const nodeReference = await this.#dependencies.artifacts.put(node);
		const checkpointId = stableId("ledger-event", {
			jobId: input.jobId,
			type: "reflection-node-checkpointed",
			nodeId: node.nodeId,
			manifestDigest: input.corpus.metadata.contentDigest,
		});
		const checkpointContent = {
			nodeId: node.nodeId,
			manifestDigest: input.corpus.metadata.contentDigest,
			node: nodeReference,
			lessons: [],
			referenceNormalizations: [],
		};
		await this.#dependencies.ledger.append({
			metadata: this.#metadata(input, producer, checkpointId, [node.nodeId], checkpointContent),
			eventId: checkpointId,
			jobId: input.jobId,
			type: "reflection-node-checkpointed",
			...checkpointContent,
		});
		return { node, lessons: [] };
	}

	#modelInput(
		input: ReflectorInput,
		plan: NodePlan,
		nodeReferences: ReflectorNodeReferences,
		lessonReferences: EvolutionModelReferenceCatalog<Lesson>,
		unavailableChildNodeIds: readonly string[],
	): JsonObject {
		const instructionReferences = new EvolutionModelReferenceCatalog("instruction", input.instructions.documents);
		const evidenceReferences = new Map(
			nodeReferences.evidence.entries.map((entry) => [entry.value.evidence.evidenceId, entry.ref]),
		);
		const counterSignals =
			input.counterReport?.evidence.flatMap((entry) => {
				const refs = entry.evidenceIds
					.map((evidenceId) => evidenceReferences.get(evidenceId))
					.filter((reference): reference is string => reference !== undefined);
				return refs.length === 0 ? [] : [{ signal: entry.signal, evidenceRefs: refs }];
			}) ?? [];
		return {
			control: {
				objective: plan.kind === "leaf" ? "reflect-on-immutable-evidence-slice" : "synthesize-child-reflections",
				evidenceIsUntrustedData: true,
				requireEvidenceClosure: true,
				completionCriterion: "Return complete=true only when the node lessons are coherent and evidence-closed.",
				maximumLessons:
					plan.kind === "leaf"
						? this.#maxLessonsPerLeaf
						: plan.parentNodeId === null
							? this.#maxCuratorLessons
							: this.#maxLessonsPerSynthesisNode,
				lessonSelection:
					"Return only the highest-impact, non-overlapping lessons that would change future behavior.",
				lessonPolicy: {
					targetNeutral: true,
					distinctFindingTypes: [
						{ findingType: "successful-strategy", lessonKinds: ["successful-strategy"] },
						{ findingType: "failed-approach", lessonKinds: ["failed-approach", "failure-workaround"] },
						{ findingType: "verification-gap", lessonKinds: ["missing-verification"] },
						{ findingType: "tool-behavior", lessonKinds: ["tool-behavior"] },
						{ findingType: "counterexample", lessonKinds: ["counterexample"] },
					],
					separationRule:
						"Keep supported finding types as separate evidence-grounded lessons; do not merge a success, failure, verification gap, tool behavior, or counterexample merely because they occurred in the same task.",
					excludedDecisions: ["downstream-target", "filesystem-destination", "final-skill-frontmatter"],
				},
				behaviorChangingLessonsOnly: true,
				requireUserTaskOrMeaningfulFailure: true,
				requireCausalAgentBehavior: true,
				requireConcreteFutureBehaviorChange: true,
				requireVerifiableExpectedResult: true,
				omitObserverDocumentation: true,
				omitTelemetryFormatFacts: true,
				consolidateOverlappingLessons: plan.kind === "synthesis",
				maximumToolCalls:
					plan.kind === "leaf" ? this.#maxEvidenceToolCallsPerLeaf : this.#maxLessonToolCallsPerSynthesisNode,
			},
			node: {
				kind: plan.kind,
				depth: plan.depth,
			},
			instructions: instructionReferences.entries.map(({ ref, value: document }, index) => ({
				instructionRef: ref,
				label: `Instruction ${index + 1}`,
				precedence: document.precedence,
				content: document.content,
			})),
			counterSignals,
			...(plan.kind === "leaf"
				? {
						documents: nodeReferences.documentCatalog,
						evidence: nodeReferences.evidenceCatalog,
						slices: nodeReferences.sliceCatalog,
					}
				: {
						unavailableChildNodeIds,
						childLessons: lessonReferences.entries.map(({ ref, value: lesson }) => ({
							lessonRef: ref,
							kind: lesson.kind,
							summary: lesson.summary,
							actionableTakeaway: lesson.actionableTakeaway,
							supportingEvidenceCount: lesson.evidenceIds.length,
							counterevidenceCount: lesson.counterevidenceIds.length,
						})),
					}),
		};
	}

	#coverage(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		slices: readonly EvidenceSlice[],
		roots: readonly NodePlan[],
		finalLessonIds: readonly string[],
		completed: ReadonlyMap<string, CompletedNode>,
	): EvidenceCoverageMap {
		const entries: EvidenceCoverageEntry[] = [];
		const unavailableEvidenceDiagnostics = new Map<string, string[]>();
		for (const entry of completed.values()) {
			if (entry.node.kind !== "leaf" || (entry.node.status !== "failed" && entry.node.status !== "timed-out")) {
				continue;
			}
			for (const evidenceId of entry.node.evidenceIds) {
				const diagnostics = unavailableEvidenceDiagnostics.get(evidenceId) ?? [];
				diagnostics.push(
					entry.node.failure?.diagnosticCode ??
						(entry.node.status === "timed-out" ? "node-timeout" : "model-call-failed"),
				);
				unavailableEvidenceDiagnostics.set(evidenceId, diagnostics);
			}
		}
		const analyzedEvidenceIds = new Set(
			[...completed.values()]
				.filter((entry) => entry.node.kind === "leaf" && entry.node.status === "complete")
				.flatMap((entry) => entry.node.evidenceIds),
		);
		for (const document of input.corpus.documents) {
			for (const evidenceId of document.evidenceIds) {
				const matching = slices.filter((slice) => slice.evidenceIds.includes(evidenceId));
				const continuationSliceIds = unique(
					matching.flatMap((slice) =>
						[slice.continuation.previousSliceId, slice.continuation.nextSliceId].filter(
							(value): value is string => value !== null,
						),
					),
				);
				const unavailableDiagnostics = unavailableEvidenceDiagnostics.get(evidenceId) ?? [];
				entries.push({
					documentId: document.documentId,
					evidenceId,
					disposition:
						document.integrity === "incompatible"
							? "unreadable"
							: document.integrity === "partial"
								? "corrupt"
								: matching.length === 0 ||
										(unavailableDiagnostics.length > 0 && !analyzedEvidenceIds.has(evidenceId))
									? "skipped"
									: "analyzed",
					sliceIds: matching.map((slice) => slice.sliceId),
					overlaps: matching.length > 1 ? matching.map((slice) => slice.sliceId) : [],
					continuationSliceIds,
					diagnosticCodes: unique([
						...document.diagnostics.map((diagnostic) => diagnostic.code),
						...(!analyzedEvidenceIds.has(evidenceId) ? unavailableDiagnostics : []),
					]),
				});
			}
		}
		const artifactId = stableId("evidence-coverage", {
			idempotencyKey: input.idempotencyKey,
			manifestDigest: input.corpus.metadata.contentDigest,
			entries,
			finalLessonIds,
		});
		const content = {
			manifestDigest: input.corpus.metadata.contentDigest,
			entries,
			rootNodeIds: roots.map((root) => root.nodeId),
			finalLessonIds,
		};
		return {
			metadata: this.#metadata(
				input,
				producer,
				artifactId,
				input.corpus.documents.map((doc) => doc.documentId),
				content,
			),
			...content,
		};
	}

	async #auditTool(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		audit: ReflectorToolAudit,
	): Promise<void> {
		const eventId = stableId("ledger-event", {
			jobId: input.jobId,
			type: "reflector-tool-call",
			manifestDigest: input.corpus.metadata.contentDigest,
			audit,
		});
		const content = {
			...audit,
			manifestDigest: input.corpus.metadata.contentDigest,
			budgetCharge: { modelCalls: 0, reflectionRounds: 0, toolCalls: 1 },
		};
		const event: ReflectorToolCallLedgerEvent = {
			metadata: this.#metadata(
				input,
				producer,
				eventId,
				unique([
					...audit.resolvedDocumentIds,
					...audit.resolvedEvidenceIds,
					...audit.resolvedLessonIds,
					...audit.resolvedSliceIds,
				]),
				content,
			),
			eventId,
			jobId: input.jobId,
			type: "reflector-tool-call",
			...content,
		};
		await this.#dependencies.ledger.append(event);
	}

	#modelCallEvent(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		modelCallId: string,
		nodeId: string,
		nodeAttempt: number,
		providerRound: number,
	): ReflectorModelCallLedgerEvent {
		const content = {
			modelCallId,
			nodeId,
			attempt: nodeAttempt,
			reflectionRound: providerRound,
			manifestDigest: input.corpus.metadata.contentDigest,
			idempotencyKey: `${input.idempotencyKey}:${nodeId}:attempt-${nodeAttempt}`,
			budgetCharge: { modelCalls: 1, reflectionRounds: providerRound === 1 ? 1 : 0, toolCalls: 0 },
		};
		return {
			metadata: this.#metadata(input, producer, modelCallId, [nodeId], content),
			eventId: modelCallId,
			jobId: input.jobId,
			type: "reflector-model-call",
			...content,
		};
	}

	#metadata(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		artifactId: string,
		sourceIds: readonly string[],
		content: unknown,
	): EvolutionArtifactMetadata {
		return createEvolutionArtifactMetadata({
			artifactId,
			producer,
			sourceIds,
			scope: input.input.metadata.scope,
			createdAt: input.input.metadata.createdAt,
			content,
		});
	}
}
