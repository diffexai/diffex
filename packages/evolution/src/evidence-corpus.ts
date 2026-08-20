import type { MaterializedEvidence } from "@earendil-works/diffex-harness-trace";
import type {
	EvidenceCorpusDocument,
	EvidenceSemanticUnit,
	EvidenceSemanticUnitKind,
	EvolutionEvidenceSource,
} from "./contracts.ts";
import { computeEvolutionContentDigest } from "./provenance.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsToolCall(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsToolCall);
	if (!isRecord(value)) return false;
	if (value.type === "toolCall" || value.role === "toolResult") return true;
	return Object.values(value).some(containsToolCall);
}

function semanticKind(evidence: MaterializedEvidence): EvidenceSemanticUnitKind {
	if (evidence.kind === "span") return "span";
	if (evidence.kind === "trace_record") {
		return evidence.payload.type === "trace_footer" ? "terminal-outcome" : "trace-record";
	}
	if (containsToolCall(evidence.payload)) return "tool-exchange";
	if (isRecord(evidence.payload.message) && evidence.payload.message.role === "user") return "turn";
	return "message";
}

export function buildEvidenceCorpusDocument(
	documentId: string,
	source: EvolutionEvidenceSource,
): EvidenceCorpusDocument {
	const semanticUnits: EvidenceSemanticUnit[] = source.invocation.evidence.map((evidence, ordinal) => ({
		unitId: `unit-${computeEvolutionContentDigest({
			materializationId: source.materializationId,
			evidenceId: evidence.evidenceId,
			ordinal,
		}).slice("sha256:".length, "sha256:".length + 32)}`,
		ordinal,
		kind: semanticKind(evidence),
		evidenceIds: [evidence.evidenceId],
		contentDigest: computeEvolutionContentDigest(evidence),
		sourceCursor: {
			traceSequence: evidence.order.traceSequence,
			timestamp: evidence.order.timestamp,
			sessionPosition: evidence.order.sessionPosition ?? null,
			parentSpanId: evidence.order.parentSpanId ?? null,
			causalIdentifiers: evidence.order.causalIdentifiers.map((identifier) => ({ ...identifier })),
			session:
				evidence.sessionSource === undefined
					? null
					: {
							bindingId: evidence.sessionSource.bindingId,
							entryId: evidence.sessionSource.entryId ?? null,
							entryOrdinal: evidence.sessionSource.entryOrdinal ?? null,
							sessionSequence: evidence.sessionSource.sessionSequence ?? null,
						},
		},
	}));
	return {
		documentId,
		sourceId: source.sourceId,
		materializationId: source.materializationId,
		contentDigest: source.contentDigest,
		materializedInvocationVersion: source.invocation.version,
		traceId: source.invocation.traceId,
		integrity: source.invocation.integrity,
		terminationStatus: source.invocation.terminationStatus,
		evidenceIds: semanticUnits.flatMap((unit) => unit.evidenceIds),
		semanticUnits,
		diagnostics: source.invocation.diagnostics.map((diagnostic) => ({
			code: diagnostic.code,
			message: diagnostic.message,
			recoverable: diagnostic.recoverable,
			traceSequence: diagnostic.traceSequence ?? null,
			bindingId: diagnostic.bindingId ?? null,
			sourceCode: diagnostic.sourceCode ?? null,
		})),
		orderingAmbiguity: [...source.invocation.ordering.ambiguity],
	};
}
