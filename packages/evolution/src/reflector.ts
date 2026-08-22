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
	ReflectionNode,
	ReflectionNodeCheckpointedLedgerEvent,
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

const DEFAULT_MAX_TOOL_CALLS = 200;
const DEFAULT_MAX_MODEL_CALLS = 100;
const DEFAULT_MAX_RECURSION_DEPTH = 8;
const DEFAULT_MAX_REFLECTION_ROUNDS = 5;
const DEFAULT_MAX_RESPONSE_RETRIES = 2;
const DEFAULT_MAX_LESSONS_PER_LEAF = 3;
const DEFAULT_MAX_UNITS_PER_SLICE = 64;
const DEFAULT_SYNTHESIS_FANOUT = 8;
const DEFAULT_MAX_LESSONS_PER_SYNTHESIS_NODE = 5;
const DEFAULT_MAX_CURATOR_LESSONS = 10;

const LESSON_KINDS = new Set<LessonKind>([
	"counterexample",
	"direct-instruction",
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
	readonly maxReflectionRounds?: number;
	readonly maxResponseRetries?: number;
	readonly maxLessonsPerLeaf?: number;
	readonly maxLessonsPerSynthesisNode?: number;
	readonly maxUnitsPerSlice?: number;
	readonly synthesisFanout?: number;
	readonly maxCuratorLessons?: number;
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
	if (response.output.complete !== true && response.output.complete !== false) {
		throw new Error("Reflector response complete must be boolean");
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
	const referenceProperties: JsonObject =
		kind === "leaf"
			? {
					supportingEvidenceRefs: {
						type: "array",
						minItems: 1,
						uniqueItems: true,
						items: { type: "string", enum: references },
					},
					counterevidenceRefs: {
						type: "array",
						uniqueItems: true,
						items: { type: "string", enum: references },
					},
				}
			: {
					sourceLessonRefs: {
						type: "array",
						minItems: 1,
						uniqueItems: true,
						items: { type: "string", enum: references },
					},
					counterLessonRefs: {
						type: "array",
						uniqueItems: true,
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
			complete: { type: "boolean" },
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
						preconditions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
						observedOutcome: { type: "string", minLength: 1 },
						...referenceProperties,
						applicabilityBoundaries: {
							type: "array",
							uniqueItems: true,
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

export class RecursiveReflector implements Reflector {
	readonly #dependencies: RecursiveReflectorDependencies;
	readonly #maxToolCalls: number;
	readonly #maxModelCalls: number;
	readonly #maxRecursionDepth: number;
	readonly #maxReflectionRounds: number;
	readonly #maxResponseRetries: number;
	readonly #maxLessonsPerLeaf: number;
	readonly #maxLessonsPerSynthesisNode: number;
	readonly #maxUnitsPerSlice: number;
	readonly #synthesisFanout: number;
	readonly #maxCuratorLessons: number;

	constructor(dependencies: RecursiveReflectorDependencies, options: RecursiveReflectorOptions = {}) {
		this.#dependencies = dependencies;
		this.#maxToolCalls = positiveInteger(options.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, "maxToolCalls");
		this.#maxModelCalls = positiveInteger(options.maxModelCalls, DEFAULT_MAX_MODEL_CALLS, "maxModelCalls");
		this.#maxRecursionDepth = positiveInteger(
			options.maxRecursionDepth,
			DEFAULT_MAX_RECURSION_DEPTH,
			"maxRecursionDepth",
		);
		this.#maxReflectionRounds = positiveInteger(
			options.maxReflectionRounds,
			DEFAULT_MAX_REFLECTION_ROUNDS,
			"maxReflectionRounds",
		);
		this.#maxResponseRetries = positiveInteger(
			options.maxResponseRetries,
			DEFAULT_MAX_RESPONSE_RETRIES,
			"maxResponseRetries",
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
	}

	async reflect(input: ReflectorInput): Promise<ReflectionResult> {
		input.signal?.throwIfAborted();
		const priorEvents = await this.#dependencies.ledger.read(input.jobId);
		const priorToolCalls = priorEvents.filter((event) => event.type === "reflector-tool-call").length;
		const priorModelCalls = priorEvents.filter((event) => event.type === "reflector-model-call").length;
		if (priorToolCalls >= this.#maxToolCalls || priorModelCalls >= this.#maxModelCalls) {
			throw new EvolutionExecutionError("Reflector budget was exhausted by prior attempts", {
				reasonCode: "reflection-budget-exhausted",
				retryable: false,
			});
		}
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
			maxToolCalls: this.#maxToolCalls - priorToolCalls,
			signal: input.signal,
			audit: (audit) => this.#auditTool(input, producer, audit),
		});
		const onAbort = () => registry.revoke();
		input.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const slices = registry.planInitialSlices(this.#maxUnitsPerSlice);
			const plans = this.#buildPlan(input, slices);
			const completed = await this.#loadCompleted(input, plans, priorEvents);
			let modelCalls = priorModelCalls;
			for (const plan of plans) {
				if (completed.has(plan.nodeId)) continue;
				const result = await this.#executeNode(input, producer, registry, plan, completed, () => {
					modelCalls += 1;
					if (modelCalls > this.#maxModelCalls) {
						throw new EvolutionExecutionError("Reflector model-call budget is exhausted", {
							reasonCode: "reflection-budget-exhausted",
							retryable: false,
						});
					}
					return modelCalls;
				});
				completed.set(plan.nodeId, result);
			}
			const nodes = plans
				.map((plan) => completed.get(plan.nodeId)?.node)
				.filter((node): node is ReflectionNode => node !== undefined);
			const lessons = plans.flatMap((plan) => completed.get(plan.nodeId)?.lessons ?? []);
			const rootPlans = plans.filter((plan) => plan.parentNodeId === null);
			const finalLessonIds = rootPlans.flatMap(
				(plan) => completed.get(plan.nodeId)?.lessons.map((lesson) => lesson.lessonId) ?? [],
			);
			const coverage = this.#coverage(input, producer, registry.slices, rootPlans, finalLessonIds);
			return { nodes, lessons, coverage, finalLessonIds };
		} finally {
			registry.revoke();
			input.signal?.removeEventListener("abort", onAbort);
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
				nodeArtifact.status !== "complete"
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
			if (lessons.length !== nodeArtifact.lessonIds.length) {
				throw new EvolutionExecutionError(`Reflection checkpoint "${event.nodeId}" is incomplete`, {
					reasonCode: "artifact-corrupt",
					retryable: false,
				});
			}
			result.set(event.nodeId, { node: nodeArtifact, lessons });
		}
		return result;
	}

	async #executeNode(
		input: ReflectorInput,
		producer: EvolutionArtifactProducer,
		registry: ReflectorToolRegistry,
		plan: NodePlan,
		completed: ReadonlyMap<string, CompletedNode>,
		chargeModelCall: () => number,
	): Promise<CompletedNode> {
		const nodeReferences = registry.nodeReferences(plan.evidenceIds);
		const childLessons = plan.childNodeIds.flatMap((nodeId) => completed.get(nodeId)?.lessons ?? []);
		const lessonReferences = new EvolutionModelReferenceCatalog("lesson", childLessons);
		const tools =
			plan.kind === "leaf" ? registry.toolsForEvidence(nodeReferences) : registry.toolsForLessons(lessonReferences);
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
		let response: EvolutionModelResponse | null = null;
		let parsed: ReturnType<typeof parseResponse> | null = null;
		let lastError: unknown = null;
		let lastFailure: "model" | "response" | null = null;
		let responseCorrection: string | null = null;
		const rejectedResponses: JsonObject[] = [];
		const invalidReferences = new Set<string>();
		const permittedReferences = new Set<string>();
		for (let round = 1; round <= this.#maxReflectionRounds && parsed?.complete !== true; round += 1) {
			for (let attempt = 1; attempt <= this.#maxResponseRetries; attempt += 1) {
				let providerCalls = 0;
				const beforeProviderCall = async () => {
					const modelCallSequence = chargeModelCall();
					providerCalls += 1;
					const modelCallId = stableId("reflector-model-call", {
						idempotencyKey: input.idempotencyKey,
						nodeId: plan.nodeId,
						round,
						modelCallSequence,
					});
					await this.#dependencies.ledger.append(
						this.#modelCallEvent(input, producer, modelCallId, plan.nodeId, round, attempt),
					);
				};
				try {
					response = await abortable(
						input.model.execute({
							stage: "reflector",
							model: input.input.modelConfiguration,
							promptVersion: input.input.promptVersions.reflector,
							idempotencyKey: `${input.idempotencyKey}:${plan.nodeId}:${round}`,
							input: this.#modelInput(input, plan, nodeReferences, lessonReferences, round, responseCorrection),
							outputSchema,
							tools,
							beforeProviderCall,
							signal: input.signal,
						}),
						input.signal,
					);
					if (providerCalls === 0) await beforeProviderCall();
				} catch (error) {
					input.signal?.throwIfAborted();
					if (error instanceof EvolutionExecutionError) throw error;
					if (providerCalls === 0) await beforeProviderCall();
					lastError = error;
					lastFailure = "model";
					continue;
				}
				if (registry.budgetExhausted) {
					throw new EvolutionExecutionError("Reflector tool-call budget is exhausted", {
						reasonCode: "reflection-budget-exhausted",
						retryable: false,
					});
				}
				try {
					parsed = parseResponse(
						response,
						plan.kind === "leaf"
							? { kind: "leaf", evidence: nodeReferences.evidence }
							: { kind: "synthesis", lessons: lessonReferences },
						maxLessons,
					);
					lastError = null;
					lastFailure = null;
					responseCorrection = null;
					break;
				} catch (error) {
					lastError = error;
					lastFailure = "response";
					responseCorrection = error instanceof Error ? error.message : "Response validation failed";
					if (error instanceof EvolutionModelReferenceError) {
						for (const reference of error.invalidReferences) invalidReferences.add(reference);
						for (const reference of error.permittedReferences) permittedReferences.add(reference);
					}
					rejectedResponses.push({
						reflectionRound: round,
						attempt,
						model: response.model,
						submissionMethod: response.submissionMethod ?? "unspecified",
						validationError: responseCorrection,
						output: response.output,
					});
				}
			}
			if (lastError !== null) {
				throw new EvolutionExecutionError(
					lastFailure === "model"
						? `Reflector model call failed for "${plan.nodeId}"`
						: `Reflector returned an invalid response for "${plan.nodeId}"`,
					{
						reasonCode: lastFailure === "model" ? "model-call-failed" : "reflection-invalid-response",
						retryable: lastFailure === "model",
						cause: lastError,
						diagnostics: {
							node: {
								nodeId: plan.nodeId,
								kind: plan.kind,
								depth: plan.depth,
								parentNodeId: plan.parentNodeId,
								childNodeIds: plan.childNodeIds,
								sliceIds: plan.sliceIds,
								evidenceIds: plan.evidenceIds,
							},
							invalidAliases: [...invalidReferences],
							permittedAliases: [...permittedReferences],
							attemptDetails: rejectedResponses,
							aliasResolutionMaps: {
								documents: nodeReferences.documents.resolutionMap((document) => document.descriptor.documentId),
								evidence: nodeReferences.evidence.resolutionMap((entry) => entry.evidence.evidenceId),
								lessons: lessonReferences.resolutionMap((lesson) => lesson.lessonId),
							},
							recoverableToolDenials: registry.recoverableDenials.slice(denialStart).map((denial) => ({
								toolName: denial.toolName,
								denialCode: denial.denialCode,
								requestedDocumentRef: denial.requestedDocumentRef,
								requestedSliceRef: denial.requestedSliceRef,
							})),
						},
					},
				);
			}
		}
		if (response === null || parsed === null || !parsed.complete) {
			throw new EvolutionExecutionError(`Reflector did not complete "${plan.nodeId}" within the refinement budget`, {
				reasonCode: "reflection-budget-exhausted",
				retryable: false,
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

	#modelInput(
		input: ReflectorInput,
		plan: NodePlan,
		nodeReferences: ReflectorNodeReferences,
		lessonReferences: EvolutionModelReferenceCatalog<Lesson>,
		round: number,
		responseCorrection: string | null,
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
				...(responseCorrection === null
					? {}
					: {
							responseCorrection: {
								reason: responseCorrection,
								instruction: "Correct the structured response and submit it again.",
							},
						}),
			},
			node: {
				kind: plan.kind,
				depth: plan.depth,
			},
			reflectionRound: round,
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
	): EvidenceCoverageMap {
		const entries: EvidenceCoverageEntry[] = [];
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
				entries.push({
					documentId: document.documentId,
					evidenceId,
					disposition:
						document.integrity === "incompatible"
							? "unreadable"
							: document.integrity === "partial"
								? "corrupt"
								: matching.length === 0
									? "skipped"
									: "analyzed",
					sliceIds: matching.map((slice) => slice.sliceId),
					overlaps: matching.length > 1 ? matching.map((slice) => slice.sliceId) : [],
					continuationSliceIds,
					diagnosticCodes: unique(document.diagnostics.map((diagnostic) => diagnostic.code)),
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
		reflectionRound: number,
		attempt: number,
	): ReflectorModelCallLedgerEvent {
		const content = {
			modelCallId,
			nodeId,
			attempt,
			reflectionRound,
			manifestDigest: input.corpus.metadata.contentDigest,
			idempotencyKey: `${input.idempotencyKey}:${nodeId}:${reflectionRound}`,
			budgetCharge: { modelCalls: 1, reflectionRounds: attempt === 1 ? 1 : 0, toolCalls: 0 },
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
