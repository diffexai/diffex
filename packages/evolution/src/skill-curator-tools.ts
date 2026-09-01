import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";
import type {
	EvolutionInputSnapshot,
	EvolutionSkillCatalogEntry,
	EvolutionSkillContentArtifact,
	JsonObject,
} from "./contracts.ts";
import { EvolutionExecutionError, EvolutionToolDeniedError } from "./errors.ts";
import { EvolutionModelReferenceCatalog, EvolutionModelReferenceError, referenceArray } from "./model-references.ts";
import type { EvolutionArtifactStore, EvolutionModelTool } from "./ports.ts";
import { computeEvolutionContentDigest, computeEvolutionTextDigest } from "./provenance.ts";

const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_MAX_REFERENCES_PER_CALL = 8;
const MAX_TRACE_CONTEXT_ITEMS = 3;

export interface SkillCuratorEvidenceBinding {
	readonly materializationId: string;
	readonly traceId: string | null;
	readonly invocation: MaterializedInvocation;
	readonly evidence: MaterializedEvidence;
}

export interface SkillCuratorToolAudit {
	readonly toolCallId: string;
	readonly toolName: "inspect_skills" | "inspect_source_evidence";
	readonly requestDigest: string;
	readonly requestedReferences: readonly string[];
	readonly resolvedEvidenceIds: readonly string[];
	readonly resolvedSkillIds: readonly string[];
	readonly resultDigest: string | null;
	readonly denialCode: string | null;
}

export interface SkillCuratorRecoverableToolDenial {
	readonly toolName: SkillCuratorToolAudit["toolName"];
	readonly denialCode: string;
	readonly requestedReferences: readonly string[];
}

export interface SkillCuratorToolRegistryOptions {
	readonly jobId: string;
	readonly input: EvolutionInputSnapshot;
	readonly artifacts: EvolutionArtifactStore;
	readonly permittedEvidenceIds: readonly string[];
	readonly signal?: AbortSignal;
	readonly audit: (event: SkillCuratorToolAudit) => Promise<void>;
	readonly maxToolCalls?: number;
	readonly maxReferencesPerCall?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schema(properties: JsonObject, required: readonly string[]): JsonObject {
	return { type: "object", additionalProperties: false, properties, required };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
	return resolved;
}

function jsonObject(value: unknown): JsonObject {
	const parsed: unknown = JSON.parse(JSON.stringify(value));
	if (!isRecord(parsed)) throw new Error("Expected a JSON object");
	return parsed as JsonObject;
}

function sameWorkspace(
	left: EvolutionSkillCatalogEntry["workspace"],
	right: EvolutionSkillContentArtifact["skill"]["workspace"],
): boolean {
	return (
		left?.repositoryId === right?.repositoryId &&
		left?.directoryId === right?.directoryId &&
		(left === null) === (right === null)
	);
}

function assertSkillArtifact(
	entry: EvolutionSkillCatalogEntry,
	artifact: Awaited<ReturnType<EvolutionArtifactStore["get"]>>,
): asserts artifact is EvolutionSkillContentArtifact {
	if (
		!("artifactKind" in artifact) ||
		artifact.artifactKind !== "skill-content" ||
		artifact.skill.skillId !== entry.skillId ||
		artifact.skill.name !== entry.name ||
		artifact.skill.description !== entry.description ||
		artifact.skill.sourceKind !== entry.sourceKind ||
		artifact.skill.scope !== entry.scope ||
		artifact.skill.source !== entry.source ||
		artifact.skill.version !== entry.version ||
		artifact.skill.contentDigest !== entry.contentDigest ||
		computeEvolutionTextDigest(artifact.skill.content) !== entry.contentDigest ||
		artifact.skill.harnessRevision !== entry.harnessRevision ||
		artifact.skill.disableModelInvocation !== entry.disableModelInvocation ||
		!sameWorkspace(entry.workspace, artifact.skill.workspace)
	) {
		throw new EvolutionExecutionError(
			`Frozen skill artifact for "${entry.skillId}" does not match its catalog entry`,
			{
				reasonCode: "artifact-corrupt",
				retryable: false,
			},
		);
	}
}

export class SkillCuratorToolRegistry {
	readonly #jobId: string;
	readonly #artifacts: EvolutionArtifactStore;
	readonly #signal?: AbortSignal;
	readonly #audit: (event: SkillCuratorToolAudit) => Promise<void>;
	readonly #maxToolCalls: number;
	readonly #maxReferencesPerCall: number;
	readonly #recoverableDenials: SkillCuratorRecoverableToolDenial[] = [];
	readonly #inspectedEvidenceIds = new Set<string>();
	readonly #inspectedSkillIds = new Set<string>();
	readonly evidence: EvolutionModelReferenceCatalog<SkillCuratorEvidenceBinding>;
	readonly skills: EvolutionModelReferenceCatalog<EvolutionSkillCatalogEntry>;
	#revoked = false;
	#toolCalls = 0;

	constructor(options: SkillCuratorToolRegistryOptions) {
		this.#jobId = options.jobId;
		this.#artifacts = options.artifacts;
		this.#signal = options.signal;
		this.#audit = options.audit;
		this.#maxToolCalls = positiveInteger(options.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, "maxToolCalls");
		this.#maxReferencesPerCall = positiveInteger(
			options.maxReferencesPerCall,
			DEFAULT_MAX_REFERENCES_PER_CALL,
			"maxReferencesPerCall",
		);
		const permittedEvidenceIds = new Set(options.permittedEvidenceIds);
		if (permittedEvidenceIds.size !== options.permittedEvidenceIds.length) {
			throw new EvolutionExecutionError("Skill Curator evidence permissions contain duplicate IDs", {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		const evidence: SkillCuratorEvidenceBinding[] = [];
		const seenEvidenceIds = new Set<string>();
		for (const source of options.input.evidenceSources) {
			for (const item of source.invocation.evidence) {
				if (!permittedEvidenceIds.has(item.evidenceId)) continue;
				if (seenEvidenceIds.has(item.evidenceId)) {
					throw new EvolutionExecutionError(`Evidence ID "${item.evidenceId}" is not unique`, {
						reasonCode: "artifact-corrupt",
						retryable: false,
					});
				}
				seenEvidenceIds.add(item.evidenceId);
				evidence.push({
					materializationId: source.materializationId,
					traceId: source.invocation.traceId,
					invocation: source.invocation,
					evidence: item,
				});
			}
		}
		const missingEvidenceIds = options.permittedEvidenceIds.filter((evidenceId) => !seenEvidenceIds.has(evidenceId));
		if (missingEvidenceIds.length > 0) {
			throw new EvolutionExecutionError("Skill Curator evidence permissions cite unavailable evidence", {
				reasonCode: "artifact-corrupt",
				retryable: false,
				diagnostics: { missingEvidenceIds },
			});
		}
		this.evidence = new EvolutionModelReferenceCatalog("evidence", evidence);
		this.skills = new EvolutionModelReferenceCatalog("skill", options.input.skillCatalog);
	}

	get recoverableDenials(): readonly SkillCuratorRecoverableToolDenial[] {
		return this.#recoverableDenials;
	}

	get skillCatalog(): readonly JsonObject[] {
		return this.skills.entries.map(({ ref, value }) => ({
			skillRef: ref,
			skillId: value.skillId,
			name: value.name,
			description: value.description,
			sourceKind: value.sourceKind,
			scope: value.scope,
			version: value.version,
			contentDigest: value.contentDigest,
			...(value.harnessRevision === undefined ? {} : { harnessRevision: value.harnessRevision }),
		}));
	}

	get tools(): readonly EvolutionModelTool[] {
		const tools: EvolutionModelTool[] = [
			{
				name: "inspect_source_evidence",
				description:
					"Inspect cited frozen source evidence, including ordering, tool results, failure signals, and deterministic outcomes.",
				inputSchema: schema(
					{
						evidenceRefs: {
							type: "array",
							minItems: 1,
							items: { type: "string", enum: this.evidence.references },
							description: `Only the first ${String(this.#maxReferencesPerCall)} references are fetched per call.`,
						},
						contextBefore: { type: "integer", minimum: 0, maximum: MAX_TRACE_CONTEXT_ITEMS },
						contextAfter: { type: "integer", minimum: 0, maximum: MAX_TRACE_CONTEXT_ITEMS },
					},
					["evidenceRefs"],
				),
				execute: (input) => this.#inspectSourceEvidence(input),
			},
		];
		if (this.skills.references.length > 0) {
			tools.push({
				name: "inspect_skills",
				description: "Inspect the complete immutable content and provenance of frozen installed or evolved skills.",
				inputSchema: schema(
					{
						skillRefs: {
							type: "array",
							minItems: 1,
							items: { type: "string", enum: this.skills.references },
							description: `Only the first ${String(this.#maxReferencesPerCall)} references are fetched per call.`,
						},
					},
					["skillRefs"],
				),
				execute: (input) => this.#inspectSkills(input),
			});
		}
		return tools;
	}

	evidenceRef(evidenceId: string): string {
		const entry = this.evidence.entries.find((candidate) => candidate.value.evidence.evidenceId === evidenceId);
		if (entry === undefined) {
			throw new EvolutionExecutionError(`Final lesson cites unavailable evidence "${evidenceId}"`, {
				reasonCode: "artifact-corrupt",
				retryable: false,
			});
		}
		return entry.ref;
	}

	wasEvidenceInspected(evidenceId: string): boolean {
		return this.#inspectedEvidenceIds.has(evidenceId);
	}

	wasSkillInspected(skillId: string): boolean {
		return this.#inspectedSkillIds.has(skillId);
	}

	revoke(): void {
		this.#revoked = true;
	}

	async #inspectSourceEvidence(input: JsonObject): Promise<JsonObject> {
		return this.#execute("inspect_source_evidence", input, async () => {
			this.#assertAllowedFields(input, ["evidenceRefs", "contextBefore", "contextAfter"]);
			const { selected, truncationNote } = this.#references(input.evidenceRefs, "evidenceRefs", this.evidence);
			const contextBefore = this.#contextSize(input.contextBefore, "contextBefore");
			const contextAfter = this.#contextSize(input.contextAfter, "contextAfter");
			const contextBySource = new Map<string, SkillCuratorEvidenceBinding>();
			for (const binding of selected) {
				const index = binding.invocation.evidence.findIndex(
					(evidence) => evidence.evidenceId === binding.evidence.evidenceId,
				);
				if (index < 0) throw new Error(`Frozen invocation is missing evidence "${binding.evidence.evidenceId}"`);
				const start = Math.max(0, index - contextBefore);
				const end = Math.min(binding.invocation.evidence.length, index + contextAfter + 1);
				for (const evidence of binding.invocation.evidence.slice(start, end)) {
					contextBySource.set(`${binding.materializationId}\0${evidence.evidenceId}`, { ...binding, evidence });
				}
			}
			const context = [...contextBySource.values()].sort(
				(left, right) => left.evidence.order.traceSequence - right.evidence.order.traceSequence,
			);
			for (const binding of selected) this.#inspectedEvidenceIds.add(binding.evidence.evidenceId);
			return {
				output: {
					evidence: context.map((binding) => ({
						evidenceRef:
							this.evidence.entries.find(
								(entry) =>
									entry.value.materializationId === binding.materializationId &&
									entry.value.evidence.evidenceId === binding.evidence.evidenceId,
							)?.ref ?? null,
						materializationId: binding.materializationId,
						traceId: binding.traceId,
						integrity: binding.invocation.integrity,
						terminationStatus: binding.invocation.terminationStatus,
						item: jsonObject(binding.evidence),
					})),
					...(truncationNote === null ? {} : { note: truncationNote }),
				},
				evidence: context,
				skills: [],
			};
		});
	}

	#contextSize(value: unknown, field: string): number {
		if (value === undefined) return 0;
		if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_TRACE_CONTEXT_ITEMS) {
			throw new EvolutionToolDeniedError(
				"invalid-range",
				`${field} must be an integer from 0 through ${String(MAX_TRACE_CONTEXT_ITEMS)}`,
			);
		}
		return value as number;
	}

	async #inspectSkills(input: JsonObject): Promise<JsonObject> {
		return this.#execute("inspect_skills", input, async () => {
			this.#assertAllowedFields(input, ["skillRefs"]);
			const { selected, truncationNote } = this.#references(input.skillRefs, "skillRefs", this.skills);
			const inspected = await Promise.all(
				selected.map(async (entry) => {
					const artifact = await this.#artifacts.get(entry.contentArtifact);
					assertSkillArtifact(entry, artifact);
					this.#inspectedSkillIds.add(entry.skillId);
					return {
						skillRef: this.skills.refFor(entry),
						skillId: entry.skillId,
						name: entry.name,
						description: entry.description,
						sourceKind: entry.sourceKind,
						scope: entry.scope,
						version: entry.version,
						contentDigest: entry.contentDigest,
						location: artifact.skill.location,
						baseDir: artifact.skill.baseDir,
						content: artifact.skill.content,
					};
				}),
			);
			return {
				output: {
					skills: inspected,
					...(truncationNote === null ? {} : { note: truncationNote }),
				},
				evidence: [],
				skills: selected,
			};
		});
	}

	#references<T>(
		value: unknown,
		field: string,
		catalog: EvolutionModelReferenceCatalog<T>,
	): { readonly selected: readonly T[]; readonly truncationNote: string | null } {
		const requested = referenceArray(value, field, catalog, { allowEmpty: false });
		return {
			selected: requested.slice(0, this.#maxReferencesPerCall),
			truncationNote:
				requested.length <= this.#maxReferencesPerCall
					? null
					: `Only the first ${String(this.#maxReferencesPerCall)} of ${String(requested.length)} requested references were fetched. Fetch at most ${String(this.#maxReferencesPerCall)} per call to inspect the remainder.`,
		};
	}

	#assertAllowedFields(input: JsonObject, fields: readonly string[]): void {
		const allowed = new Set(fields);
		const unexpected = Object.keys(input).find((candidate) => !allowed.has(candidate));
		if (unexpected !== undefined) {
			throw new EvolutionToolDeniedError("invalid-request", `Tool request does not permit field "${unexpected}"`);
		}
	}

	async #execute(
		toolName: SkillCuratorToolAudit["toolName"],
		input: JsonObject,
		run: () => Promise<{
			readonly output: JsonObject;
			readonly evidence: readonly SkillCuratorEvidenceBinding[];
			readonly skills: readonly EvolutionSkillCatalogEntry[];
		}>,
	): Promise<JsonObject> {
		this.#toolCalls += 1;
		const requestedReferences = Object.values(input).flatMap((value) =>
			Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
		);
		let resolvedEvidenceIds: readonly string[] = [];
		let resolvedSkillIds: readonly string[] = [];
		let resultDigest: string | null = null;
		let denialCode: string | null = null;
		try {
			if (this.#revoked)
				throw new EvolutionToolDeniedError("registry-revoked", "Skill Curator tool registry is revoked");
			if (this.#toolCalls > this.#maxToolCalls) {
				throw new EvolutionToolDeniedError("tool-budget-exhausted", "Skill Curator tool budget is exhausted");
			}
			this.#signal?.throwIfAborted();
			const result = await run();
			resolvedEvidenceIds = result.evidence.map((binding) => binding.evidence.evidenceId);
			resolvedSkillIds = result.skills.map((skill) => skill.skillId);
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
				toolCallId: `skill-curator-tool-${this.#jobId}-${String(this.#toolCalls)}`,
				toolName,
				requestDigest: computeEvolutionContentDigest(input),
				requestedReferences,
				resolvedEvidenceIds,
				resolvedSkillIds,
				resultDigest,
				denialCode,
			});
		}
	}
}
