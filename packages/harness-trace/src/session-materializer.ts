import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { causalIdentifiers } from "./evidence-utils.ts";
import type {
	MaterializationDiagnostic,
	MaterializedEvidence,
	MaterializedSessionEvidence,
	MaterializedSessionSource,
	MaterializedTraceRecordSource,
} from "./materialized-types.ts";
import type {
	AgentHarnessSessionSegmentCursor,
	CodingAgentV3EntryCursor,
	CodingAgentV3SessionSegmentCursor,
	TraceSessionAttachRecord,
	TraceSessionSegmentRecord,
} from "./types.ts";

type CodingAgentSessionSegment = TraceSessionSegmentRecord & {
	readonly cursor: CodingAgentV3SessionSegmentCursor;
};

type AgentHarnessSessionSegment = TraceSessionSegmentRecord & {
	readonly cursor: AgentHarnessSessionSegmentCursor;
};

export interface SessionMaterializationRequest {
	readonly traceId: string | null;
	readonly attachment: TraceSessionAttachRecord;
	readonly segments: readonly TraceSessionSegmentRecord[];
	readonly segmentSources: ReadonlyMap<number, MaterializedTraceRecordSource>;
	readonly resolvedPath: string | undefined;
}

export interface SessionMaterializationResult {
	readonly evidence: readonly MaterializedEvidence[];
	readonly diagnostics: readonly MaterializationDiagnostic[];
}

interface JsonlLine {
	readonly text: string;
	readonly lineNumber: number;
	readonly terminated: boolean;
}

interface ObservedCodingCursor {
	readonly entryId: string;
	readonly contentDigest: string;
	readonly prefixDigest: string;
}

const SESSION_ORDER_AMBIGUITY =
	"Session items have durable cursor order, but their position relative to trace records at the segment boundary is not totally ordered";

async function* streamJsonlLines(path: string): AsyncGenerator<JsonlLine> {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let lineNumber = 0;
	for await (const chunk of createReadStream(path)) {
		pending += decoder.write(chunk);
		let newline = pending.indexOf("\n");
		while (newline !== -1) {
			lineNumber++;
			yield { text: pending.slice(0, newline), lineNumber, terminated: true };
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
	}
	pending += decoder.end();
	if (pending.length > 0) {
		lineNumber++;
		yield { text: pending, lineNumber, terminated: false };
	}
}

function objectValue(text: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
}

function diagnostic(
	request: SessionMaterializationRequest,
	code: MaterializationDiagnostic["code"],
	message: string,
	traceSequence?: number,
): MaterializationDiagnostic {
	return {
		code,
		message,
		recoverable: true,
		...(traceSequence === undefined ? {} : { traceSequence }),
		bindingId: request.attachment.bindingId,
	};
}

function lineDiagnostic(
	request: SessionMaterializationRequest,
	line: JsonlLine,
	message: string,
): MaterializationDiagnostic {
	return diagnostic(
		request,
		line.terminated ? "session_invalid" : "session_truncated",
		`${message} at line ${line.lineNumber}`,
	);
}

function sessionTimestamp(value: unknown): string | null {
	if (typeof value === "string") {
		const milliseconds = Date.parse(value);
		return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		const timestamp = new Date(value);
		return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
	}
	return null;
}

function traceSources(
	request: SessionMaterializationRequest,
	segments: readonly TraceSessionSegmentRecord[],
): readonly MaterializedTraceRecordSource[] {
	return segments
		.map((segment) => request.segmentSources.get(segment.sequence))
		.filter((source): source is MaterializedTraceRecordSource => source !== undefined);
}

function sessionSource(
	request: SessionMaterializationRequest,
	segments: readonly TraceSessionSegmentRecord[],
	position: { entryId?: string; entryOrdinal?: number; sessionSequence?: number },
): MaterializedSessionSource {
	return {
		bindingId: request.attachment.bindingId,
		sessionId: request.attachment.sessionId,
		path: request.attachment.path,
		...(request.resolvedPath === undefined || request.resolvedPath === request.attachment.path
			? {}
			: { resolvedPath: request.resolvedPath }),
		sessionFormat: request.attachment.sessionFormat,
		formatVersion: request.attachment.formatVersion,
		segmentTraceSequences: segments.map((segment) => segment.sequence),
		...position,
	};
}

function sessionEvidence(
	request: SessionMaterializationRequest,
	segments: readonly TraceSessionSegmentRecord[],
	itemType: string,
	payload: Readonly<Record<string, unknown>>,
	position: { entryId?: string; entryOrdinal?: number; sessionSequence?: number },
): MaterializedSessionEvidence {
	const traceSequence = Math.min(...segments.map((segment) => segment.sequence));
	const sessionPosition = position.entryOrdinal ?? position.sessionSequence ?? 0;
	const source = sessionSource(request, segments, position);
	const stablePosition = position.entryId
		? `entry:${position.entryId}:ordinal:${position.entryOrdinal ?? 0}`
		: `sequence:${position.sessionSequence ?? 0}`;
	return {
		evidenceId: `${request.traceId ?? "unknown-trace"}:session:${request.attachment.bindingId}:${stablePosition}`,
		kind: "session_item",
		itemType,
		order: {
			traceSequence,
			timestamp: sessionTimestamp(payload.timestamp),
			sessionPosition,
			causalIdentifiers: causalIdentifiers(
				payload,
				...segments.map((segment) =>
					segment.taskLineageId === undefined ? null : { "diffex.task.lineage.id": segment.taskLineageId },
				),
			),
			ambiguity: [SESSION_ORDER_AMBIGUITY],
		},
		traceSources: traceSources(request, segments),
		sessionSource: source,
		payload,
	};
}

function cursorDigest(cursor: CodingAgentV3EntryCursor, observed: ObservedCodingCursor): string {
	return cursor.digest.kind === "content" ? observed.contentDigest : observed.prefixDigest;
}

function verifyCodingCursor(
	request: SessionMaterializationRequest,
	segment: TraceSessionSegmentRecord,
	name: "start" | "end",
	cursor: CodingAgentV3EntryCursor,
	observed: ReadonlyMap<number, ObservedCodingCursor>,
	entryCount: number,
): MaterializationDiagnostic[] {
	const actual = observed.get(cursor.entryOrdinal);
	if (!actual) {
		return [
			diagnostic(
				request,
				"session_truncated",
				`Session segment ${name} ordinal ${cursor.entryOrdinal} is unavailable after ${entryCount} entries`,
				segment.sequence,
			),
		];
	}
	const diagnostics: MaterializationDiagnostic[] = [];
	if (actual.entryId !== cursor.entryId) {
		diagnostics.push(
			diagnostic(
				request,
				"session_changed",
				`Session segment ${name} entry changed from ${cursor.entryId} to ${actual.entryId}`,
				segment.sequence,
			),
		);
	}
	if (cursorDigest(cursor, actual) !== cursor.digest.value) {
		diagnostics.push(
			diagnostic(
				request,
				"session_changed",
				`Session segment ${name} ${cursor.digest.kind} digest does not match entry ${cursor.entryId}`,
				segment.sequence,
			),
		);
	}
	return diagnostics;
}

async function materializeCodingAgentSession(
	request: SessionMaterializationRequest,
): Promise<SessionMaterializationResult> {
	if (request.attachment.formatVersion !== 3) {
		return {
			evidence: [],
			diagnostics: [
				diagnostic(
					request,
					"session_incompatible",
					`Coding-agent session format v${request.attachment.formatVersion} is unsupported`,
				),
			],
		};
	}
	const segments = request.segments.filter(
		(segment): segment is CodingAgentSessionSegment => segment.cursor.kind === "coding-agent-v3",
	);
	const diagnostics: MaterializationDiagnostic[] = [];
	const evidence: MaterializedEvidence[] = [];
	const observed = new Map<number, ObservedCodingCursor>();
	const prefixHash = createHash("sha256");
	let headerSeen = false;
	let entryOrdinal = 0;

	for await (const line of streamJsonlLines(request.resolvedPath as string)) {
		if (line.text.trim().length === 0) continue;
		const value = objectValue(line.text);
		if (!value) {
			diagnostics.push(lineDiagnostic(request, line, "Session contains invalid JSON"));
			continue;
		}
		if (!headerSeen) {
			headerSeen = true;
			if (value.type !== "session" || value.version !== 3) {
				diagnostics.push(
					diagnostic(request, "session_incompatible", "Coding-agent session header is not format v3"),
				);
				continue;
			}
			if (value.id !== request.attachment.sessionId) {
				diagnostics.push(
					diagnostic(
						request,
						"session_changed",
						`Session header id ${String(value.id)} does not match ${request.attachment.sessionId}`,
					),
				);
			}
			continue;
		}

		if (typeof value.id !== "string" || typeof value.type !== "string" || value.type === "session") {
			diagnostics.push(lineDiagnostic(request, line, "Session entry is invalid"));
			continue;
		}
		const encoded = JSON.stringify(value);
		const contentDigest = createHash("sha256").update(encoded).digest("hex");
		prefixHash.update(`${encoded}\n`);
		observed.set(entryOrdinal, {
			entryId: value.id,
			contentDigest,
			prefixDigest: prefixHash.copy().digest("hex"),
		});
		const containingSegments = segments.filter(
			(segment) =>
				entryOrdinal >= segment.cursor.start.entryOrdinal && entryOrdinal <= segment.cursor.end.entryOrdinal,
		);
		if (containingSegments.length > 0) {
			evidence.push(
				sessionEvidence(request, containingSegments, value.type, value, {
					entryId: value.id,
					entryOrdinal,
				}),
			);
		}
		entryOrdinal++;
	}

	if (!headerSeen)
		diagnostics.push(diagnostic(request, "session_truncated", "Coding-agent session header is missing"));
	for (const segment of segments) {
		diagnostics.push(
			...verifyCodingCursor(request, segment, "start", segment.cursor.start, observed, entryOrdinal),
			...verifyCodingCursor(request, segment, "end", segment.cursor.end, observed, entryOrdinal),
		);
	}
	return { evidence, diagnostics };
}

function agentHarnessItemType(value: Readonly<Record<string, unknown>>): string {
	if (typeof value.kind !== "string") return "unknown";
	if (typeof value.type === "string") return `${value.kind}.${value.type}`;
	if (typeof value.fact === "string") return `${value.kind}.${value.fact}`;
	return value.kind;
}

async function materializeAgentHarnessSession(
	request: SessionMaterializationRequest,
): Promise<SessionMaterializationResult> {
	const segments = request.segments.filter(
		(segment): segment is AgentHarnessSessionSegment => segment.cursor.kind === "agent-harness",
	);
	const diagnostics: MaterializationDiagnostic[] = [];
	const evidence: MaterializedEvidence[] = [];
	const observedSequences = new Set<number>();
	let headerSeen = false;

	for await (const line of streamJsonlLines(request.resolvedPath as string)) {
		if (line.text.trim().length === 0) continue;
		const value = objectValue(line.text);
		if (!value) {
			diagnostics.push(lineDiagnostic(request, line, "Session contains invalid JSON"));
			continue;
		}
		if (!headerSeen) {
			headerSeen = true;
			if (value.kind !== "header" || value.version !== request.attachment.formatVersion) {
				diagnostics.push(
					diagnostic(
						request,
						"session_incompatible",
						`AgentHarness session header does not match format v${request.attachment.formatVersion}`,
					),
				);
				continue;
			}
			if (value.id !== request.attachment.sessionId) {
				diagnostics.push(
					diagnostic(
						request,
						"session_changed",
						`Session header id ${String(value.id)} does not match ${request.attachment.sessionId}`,
					),
				);
			}
			continue;
		}

		if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) {
			diagnostics.push(lineDiagnostic(request, line, "AgentHarness session item has an invalid sequence"));
			continue;
		}
		const sequence = value.seq as number;
		if (observedSequences.has(sequence)) {
			diagnostics.push(
				diagnostic(request, "session_changed", `AgentHarness session sequence ${sequence} is duplicated`),
			);
			continue;
		}
		observedSequences.add(sequence);
		const containingSegments = segments.filter(
			(segment) => sequence >= segment.cursor.startSequence && sequence <= segment.cursor.endSequence,
		);
		if (containingSegments.length > 0) {
			evidence.push(
				sessionEvidence(request, containingSegments, agentHarnessItemType(value), value, {
					sessionSequence: sequence,
				}),
			);
		}
	}

	if (!headerSeen)
		diagnostics.push(diagnostic(request, "session_truncated", "AgentHarness session header is missing"));
	for (const segment of segments) {
		const present = [...observedSequences]
			.filter((sequence) => sequence >= segment.cursor.startSequence && sequence <= segment.cursor.endSequence)
			.sort((left, right) => left - right);
		let expected = segment.cursor.startSequence;
		for (const sequence of present) {
			if (sequence > expected) {
				diagnostics.push(
					diagnostic(
						request,
						"session_truncated",
						`AgentHarness session sequences ${expected} through ${sequence - 1} are unavailable`,
						segment.sequence,
					),
				);
			}
			expected = sequence + 1;
		}
		if (expected <= segment.cursor.endSequence) {
			diagnostics.push(
				diagnostic(
					request,
					"session_truncated",
					`AgentHarness session sequences ${expected} through ${segment.cursor.endSequence} are unavailable`,
					segment.sequence,
				),
			);
		}
	}
	return { evidence, diagnostics };
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function materializeSessionEvidence(
	request: SessionMaterializationRequest,
): Promise<SessionMaterializationResult> {
	if (!request.resolvedPath) {
		return {
			evidence: [],
			diagnostics: [diagnostic(request, "session_missing", "Referenced session could not be resolved")],
		};
	}
	try {
		if (request.attachment.sessionFormat === "coding-agent") return await materializeCodingAgentSession(request);
		if (request.attachment.sessionFormat === "agent-harness") return await materializeAgentHarnessSession(request);
		return {
			evidence: [],
			diagnostics: [
				diagnostic(
					request,
					"session_incompatible",
					`Session format ${request.attachment.sessionFormat} is unsupported`,
				),
			],
		};
	} catch (error) {
		const missing = errorCode(error) === "ENOENT";
		return {
			evidence: [],
			diagnostics: [
				diagnostic(
					request,
					missing ? "session_missing" : "session_invalid",
					missing ? `Referenced session is missing at ${request.resolvedPath}` : errorMessage(error),
				),
			],
		};
	}
}
