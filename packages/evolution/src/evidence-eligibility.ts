import type { MaterializedEvidence, MaterializedInvocation } from "@earendil-works/diffex-harness-trace";

export const NON_SUBSTANTIVE_RUNTIME_TRACE_REASON = "non-substantive-runtime-trace" as const;

export type EvolutionEvidenceEligibility =
	| { readonly eligible: true }
	| { readonly eligible: false; readonly reason: typeof NON_SUBSTANTIVE_RUNTIME_TRACE_REASON };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasContent(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.some(hasContent);
	if (!isRecord(value)) return false;
	if (value.type === "text") return hasContent(value.text);
	if (value.type === "toolCall" || value.role === "toolResult") return true;
	return Object.values(value).some(hasContent);
}

function hasSubstantiveMessage(evidence: MaterializedEvidence): boolean {
	if (evidence.kind !== "session_item") return false;
	const message = evidence.payload.message;
	if (!isRecord(message)) return false;
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return false;
	return hasContent(message.content);
}

function hasSubstantiveOperation(evidence: MaterializedEvidence): boolean {
	if (evidence.kind !== "span") return false;
	const operationKind = evidence.payload.startAttributes["diffex.operation.kind"];
	if (evidence.payload.name === "diffex.coding_agent.diagnostic" || operationKind === "abort") return false;
	if (evidence.payload.name === "diffex.coding_agent.operation") {
		return evidence.payload.status?.status === "error";
	}
	return true;
}

function isTaskEvidence(evidence: MaterializedEvidence): boolean {
	return hasSubstantiveMessage(evidence) || hasSubstantiveOperation(evidence);
}

function isMeaningfulDiagnostic(evidence: MaterializedEvidence): boolean {
	return (
		evidence.kind === "span" &&
		evidence.payload.name === "diffex.coding_agent.diagnostic" &&
		evidence.payload.status?.status === "error"
	);
}

/** Classifies whether a materialized runtime trace can inform future harness behavior. */
export function classifyEvolutionEvidence(invocation: MaterializedInvocation): EvolutionEvidenceEligibility {
	if (invocation.evidence.some(isTaskEvidence)) {
		return { eligible: true };
	}
	return { eligible: false, reason: NON_SUBSTANTIVE_RUNTIME_TRACE_REASON };
}

/** Retains only evidence that can inform future harness behavior. */
export function selectEvolutionEvidence(invocation: MaterializedInvocation): MaterializedInvocation {
	const hasTaskEvidence = invocation.evidence.some(isTaskEvidence);
	return {
		...invocation,
		evidence: invocation.evidence.filter(
			(evidence) => isTaskEvidence(evidence) || (hasTaskEvidence && isMeaningfulDiagnostic(evidence)),
		),
	};
}
