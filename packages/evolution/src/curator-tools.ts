import type {
	EvolutionInputSnapshot,
	EvolutionMemoryItem,
	InstructionDocumentSnapshot,
	JsonObject,
	Lesson,
} from "./contracts.ts";
import { EvolutionExecutionError, EvolutionToolDeniedError } from "./errors.ts";
import { type EvolutionMemoryBlock, parseEvolutionMemoryBlocks } from "./evolution-memory-writer.ts";
import { EvolutionModelReferenceCatalog, EvolutionModelReferenceError, referenceArray } from "./model-references.ts";
import type { EvolutionModelTool } from "./ports.ts";
import { computeEvolutionContentDigest } from "./provenance.ts";

export interface CuratorMemoryBinding {
	readonly item: EvolutionMemoryItem;
	readonly block: EvolutionMemoryBlock;
}

export interface CuratorToolAudit {
	readonly toolCallId: string;
	readonly toolName: "inspect_instructions" | "inspect_lessons" | "inspect_memory";
	readonly requestDigest: string;
	readonly requestedReferences: readonly string[];
	readonly resolvedInstructionPaths: readonly string[];
	readonly resolvedLessonIds: readonly string[];
	readonly resolvedMemoryItemIds: readonly string[];
	readonly resultDigest: string | null;
	readonly denialCode: string | null;
}

export interface CuratorRecoverableToolDenial {
	readonly toolName: CuratorToolAudit["toolName"];
	readonly denialCode: string;
	readonly requestedReferences: readonly string[];
}

export interface CuratorToolRegistryOptions {
	readonly jobId: string;
	readonly input: EvolutionInputSnapshot;
	readonly lessons: readonly Lesson[];
	readonly instructions: readonly InstructionDocumentSnapshot[];
	readonly signal?: AbortSignal;
	readonly audit: (event: CuratorToolAudit) => Promise<void>;
}

function schema(properties: JsonObject, required: readonly string[]): JsonObject {
	return { type: "object", additionalProperties: false, properties, required };
}

function preview(value: string): string {
	const normalized = value.trim().replace(/\s+/gu, " ");
	return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`;
}

export class CuratorToolRegistry {
	readonly #jobId: string;
	readonly #renderedMemory: string;
	readonly #renderedMemoryDigest: string;
	readonly #signal?: AbortSignal;
	readonly #audit: (event: CuratorToolAudit) => Promise<void>;
	readonly #recoverableDenials: CuratorRecoverableToolDenial[] = [];
	readonly lessons: EvolutionModelReferenceCatalog<Lesson>;
	readonly instructions: EvolutionModelReferenceCatalog<InstructionDocumentSnapshot>;
	readonly memory: EvolutionModelReferenceCatalog<CuratorMemoryBinding>;
	#revoked = false;
	#toolCalls = 0;

	constructor(options: CuratorToolRegistryOptions) {
		this.#jobId = options.jobId;
		this.#renderedMemory = options.input.harness.memory;
		this.#renderedMemoryDigest = options.input.harness.memoryContentDigest;
		this.#signal = options.signal;
		this.#audit = options.audit;
		this.lessons = new EvolutionModelReferenceCatalog("lesson", options.lessons);
		this.instructions = new EvolutionModelReferenceCatalog("instruction", options.instructions);
		const blocks = parseEvolutionMemoryBlocks(options.input.harness.memory);
		if (blocks.length !== options.input.harness.activeMemoryItems.length) {
			throw new EvolutionExecutionError("Active memory items do not align with rendered memory blocks", {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		if (
			blocks.some(
				(block, index) =>
					computeEvolutionContentDigest(block.content) !==
					options.input.harness.activeMemoryItems[index]?.contentDigest,
			)
		) {
			throw new EvolutionExecutionError("Active memory item digests do not match rendered memory blocks", {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		this.memory = new EvolutionModelReferenceCatalog(
			"memory",
			options.input.harness.activeMemoryItems.map((item, index) => ({
				item,
				block: blocks[index] as EvolutionMemoryBlock,
			})),
		);
	}

	get recoverableDenials(): readonly CuratorRecoverableToolDenial[] {
		return this.#recoverableDenials;
	}

	get renderedMemoryDigest(): string {
		return this.#renderedMemoryDigest;
	}

	get lessonCatalog(): readonly JsonObject[] {
		return this.lessons.entries.map(({ ref, value }) => ({
			lessonRef: ref,
			kind: value.kind,
			summary: value.summary,
			actionableTakeaway: value.actionableTakeaway,
		}));
	}

	get instructionCatalog(): readonly JsonObject[] {
		return this.instructions.entries.map(({ ref, value }, index) => ({
			instructionRef: ref,
			label: `Instruction ${index + 1}`,
			precedence: value.precedence,
			preview: preview(value.content),
		}));
	}

	get memoryCatalog(): readonly JsonObject[] {
		return [
			{ memoryRef: "M0", label: "Complete rendered memory", preview: preview(this.#renderedMemory) },
			...this.memory.entries.map(({ ref, value }, index) => ({
				memoryRef: ref,
				label: `Memory item ${index + 1}`,
				section: value.block.section,
				preview: preview(value.block.content),
				removable: value.item.ledger.origin === "evolution",
			})),
		];
	}

	get tools(): readonly EvolutionModelTool[] {
		return [
			{
				name: "inspect_lessons",
				description: "Inspect complete final lesson content.",
				inputSchema: schema(
					{
						lessonRefs: {
							type: "array",
							minItems: 1,
							items: { type: "string", enum: this.lessons.references },
						},
					},
					["lessonRefs"],
				),
				execute: (input) => this.#inspectLessons(input),
			},
			{
				name: "inspect_instructions",
				description: "Inspect complete applicable instruction content.",
				inputSchema: schema(
					{
						instructionRefs: {
							type: "array",
							minItems: 1,
							items: { type: "string", enum: this.instructions.references },
						},
					},
					["instructionRefs"],
				),
				execute: (input) => this.#inspectInstructions(input),
			},
			{
				name: "inspect_memory",
				description: "Inspect complete rendered memory or active memory items.",
				inputSchema: schema(
					{
						memoryRefs: {
							type: "array",
							minItems: 1,
							items: { type: "string", enum: ["M0", ...this.memory.references] },
						},
					},
					["memoryRefs"],
				),
				execute: (input) => this.#inspectMemory(input),
			},
		];
	}

	revoke(): void {
		this.#revoked = true;
	}

	async #inspectLessons(input: JsonObject): Promise<JsonObject> {
		return this.#execute("inspect_lessons", input, () => {
			this.#assertOnlyField(input, "lessonRefs");
			const selected = referenceArray(input.lessonRefs, "lessonRefs", this.lessons, { allowEmpty: false });
			return {
				output: {
					lessons: selected.map((lesson) => ({
						lessonRef: this.lessons.refFor(lesson),
						kind: lesson.kind,
						summary: lesson.summary,
						preconditions: lesson.preconditions,
						observedOutcome: lesson.observedOutcome,
						applicabilityBoundaries: lesson.applicabilityBoundaries,
						uncertainty: lesson.uncertainty,
						actionableTakeaway: lesson.actionableTakeaway,
					})),
				},
				instructions: [],
				lessons: selected,
				memory: [],
			};
		});
	}

	async #inspectInstructions(input: JsonObject): Promise<JsonObject> {
		return this.#execute("inspect_instructions", input, () => {
			this.#assertOnlyField(input, "instructionRefs");
			const selected = referenceArray(input.instructionRefs, "instructionRefs", this.instructions, {
				allowEmpty: false,
			});
			return {
				output: {
					instructions: selected.map((instruction) => ({
						instructionRef: this.instructions.refFor(instruction),
						precedence: instruction.precedence,
						content: instruction.content,
					})),
				},
				instructions: selected,
				lessons: [],
				memory: [],
			};
		});
	}

	async #inspectMemory(input: JsonObject): Promise<JsonObject> {
		return this.#execute("inspect_memory", input, () => {
			this.#assertOnlyField(input, "memoryRefs");
			if (!Array.isArray(input.memoryRefs) || input.memoryRefs.some((value) => typeof value !== "string")) {
				throw new EvolutionToolDeniedError("invalid-reference", "memoryRefs must be an array of references");
			}
			const refs = input.memoryRefs as readonly string[];
			if (new Set(refs).size !== refs.length || refs.length === 0) {
				throw new EvolutionToolDeniedError("invalid-reference", "memoryRefs must be non-empty and unique");
			}
			const itemRefs = refs.filter((reference) => reference !== "M0");
			let selected: readonly CuratorMemoryBinding[];
			try {
				selected = referenceArray(itemRefs, "memoryRefs", this.memory);
			} catch (error) {
				if (error instanceof EvolutionModelReferenceError) {
					throw new EvolutionToolDeniedError(
						"invalid-reference",
						`Memory reference is not permitted. Permitted memory references: M0, ${this.memory.references.join(", ")}`,
					);
				}
				throw error;
			}
			return {
				output: {
					memory: refs.map((reference) => {
						if (reference === "M0") {
							return {
								memoryRef: "M0",
								section: null,
								content: this.#renderedMemory,
								removable: false,
								wholeMemory: true,
							};
						}
						const binding = this.memory.resolve(reference, "memoryRefs");
						return {
							memoryRef: reference,
							section: binding.block.section,
							content: binding.block.content,
							removable: binding.item.ledger.origin === "evolution",
							wholeMemory: false,
						};
					}),
				},
				instructions: [],
				lessons: [],
				memory: selected,
			};
		});
	}

	#assertOnlyField(input: JsonObject, field: string): void {
		const unexpected = Object.keys(input).find((candidate) => candidate !== field);
		if (unexpected !== undefined) {
			throw new EvolutionToolDeniedError("invalid-request", `Tool request does not permit field "${unexpected}"`);
		}
	}

	async #execute(
		toolName: CuratorToolAudit["toolName"],
		input: JsonObject,
		run: () => {
			readonly output: JsonObject;
			readonly instructions: readonly InstructionDocumentSnapshot[];
			readonly lessons: readonly Lesson[];
			readonly memory: readonly CuratorMemoryBinding[];
		},
	): Promise<JsonObject> {
		this.#toolCalls += 1;
		const requestedReferences = Object.values(input).flatMap((value) =>
			Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
		);
		let resolvedInstructionPaths: readonly string[] = [];
		let resolvedLessonIds: readonly string[] = [];
		let resolvedMemoryItemIds: readonly string[] = [];
		let resultDigest: string | null = null;
		let denialCode: string | null = null;
		try {
			if (this.#revoked) throw new EvolutionToolDeniedError("registry-revoked", "Curator tool registry is revoked");
			this.#signal?.throwIfAborted();
			const result = run();
			resolvedInstructionPaths = result.instructions.map((instruction) => instruction.path);
			resolvedLessonIds = result.lessons.map((lesson) => lesson.lessonId);
			resolvedMemoryItemIds = result.memory.map((binding) => binding.item.memoryItemId);
			resultDigest = computeEvolutionContentDigest(result.output);
			return result.output;
		} catch (error) {
			const denial =
				error instanceof EvolutionModelReferenceError
					? new EvolutionToolDeniedError("invalid-reference", error.message)
					: error;
			denialCode = denial instanceof EvolutionToolDeniedError ? denial.code : "tool-failed";
			if (denial instanceof EvolutionToolDeniedError && denial.recoverable) {
				this.#recoverableDenials.push({ toolName, denialCode, requestedReferences });
			}
			throw denial;
		} finally {
			await this.#audit({
				toolCallId: `curator-tool-${this.#jobId}-${this.#toolCalls}`,
				toolName,
				requestDigest: computeEvolutionContentDigest(input),
				requestedReferences,
				resolvedInstructionPaths,
				resolvedLessonIds,
				resolvedMemoryItemIds,
				resultDigest,
				denialCode,
			});
		}
	}
}
