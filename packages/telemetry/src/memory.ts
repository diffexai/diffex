import type {
	AttributeValue,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetrySpan,
} from "./index.ts";
import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

export interface RecordedTelemetryEvent {
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface RecordedTelemetrySpan {
	readonly id: number;
	readonly parentId: number | null;
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly events: readonly RecordedTelemetryEvent[];
	readonly status: SpanStatus;
	readonly settled: boolean;
	readonly endSequence?: number;
}

export interface InMemoryTelemetryContextOptions {
	/** Maximum number of recorded spans retained in memory. Defaults to unbounded. */
	maxSpans?: number;
}

export interface SettledTelemetrySpanSnapshot {
	/** Highest settlement sequence observed by this capture. */
	readonly cursor: number;
	/** Detached settled spans newer than the requested cursor, ordered by settlement. */
	readonly spans: readonly RecordedTelemetrySpan[];
	/** Cumulative spans evicted or declined because the configured capacity was full. */
	readonly droppedSpanCount: number;
}

interface MutableRecordedTelemetryEvent {
	name: string;
	attributes: SpanAttributes;
}

interface MutableRecordedTelemetrySpan {
	id: number;
	parentId: number | null;
	name: string;
	attributes: SpanAttributes;
	events: MutableRecordedTelemetryEvent[];
	status: SpanStatus;
	explicitStatus: boolean;
	settled: boolean;
	endSequence?: number;
}

interface InMemoryTelemetryState {
	spans: MutableRecordedTelemetrySpan[];
	nextSpanId: number;
	nextEndSequence: number;
	maxSpans: number;
	droppedSpanCount: number;
}

function copyAttributeValue(value: AttributeValue): AttributeValue {
	return Array.isArray(value) ? ([...value] as AttributeValue) : value;
}

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	const copy: SpanAttributes = {};
	if (!attributes) return copy;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) copy[name] = copyAttributeValue(value);
	}
	return copy;
}

function mergeAttributes(current: SpanAttributes, attributes: SpanAttributes): SpanAttributes {
	const merged = copyAttributes(current);
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) merged[name] = copyAttributeValue(value);
	}
	return merged;
}

function copyStatus(status: SpanStatus): SpanStatus {
	if (status.status === "ok") return { status: "ok" };
	return status.error
		? { status: "error", error: { name: status.error.name, message: status.error.message } }
		: { status: "error" };
}

function automaticErrorStatus(error: unknown): SpanStatus {
	try {
		if (error instanceof Error) {
			return { status: "error", error: { name: error.name, message: error.message } };
		}
	} catch {
		// Error inspection is passive. Fall through to an error status without details.
	}
	return { status: "error" };
}

function settleSpan(
	state: InMemoryTelemetryState,
	span: MutableRecordedTelemetrySpan,
	failed: boolean,
	error?: unknown,
): void {
	if (span.settled) return;
	if (failed && !span.explicitStatus) span.status = automaticErrorStatus(error);
	span.settled = true;
	span.endSequence = state.nextEndSequence++;
}

function createSpan(
	state: InMemoryTelemetryState,
	parent: MutableRecordedTelemetrySpan | undefined,
	options: SpanOptions,
): MutableRecordedTelemetrySpan {
	const name = options.name;
	const attributes = copyAttributes(options.attributes);
	return {
		id: state.nextSpanId++,
		parentId: parent?.id ?? null,
		name,
		attributes,
		events: [],
		status: { status: "ok" },
		explicitStatus: false,
		settled: false,
	};
}

function retainSpan(state: InMemoryTelemetryState, span: MutableRecordedTelemetrySpan): boolean {
	while (state.spans.length >= state.maxSpans) {
		const settledIndex = state.spans.findIndex((candidate) => candidate.settled);
		if (settledIndex === -1) {
			state.droppedSpanCount += 1;
			return false;
		}
		state.spans.splice(settledIndex, 1);
		state.droppedSpanCount += 1;
	}
	state.spans.push(span);
	return true;
}

function startInMemorySpan<T>(
	state: InMemoryTelemetryState,
	parent: MutableRecordedTelemetrySpan | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?.settled) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);

	let recordedSpan: MutableRecordedTelemetrySpan;
	try {
		recordedSpan = createSpan(state, parent, options);
		if (!retainSpan(state, recordedSpan)) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
	} catch {
		return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
	}

	const span: TelemetrySpan = {
		startSpan: <Result>(
			childOptions: SpanOptions,
			childCallback: (child: TelemetrySpan) => Result | Promise<Result>,
		) => startInMemorySpan(state, recordedSpan, childOptions, childCallback),
		addEvent(name, attributes) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.events.push({ name, attributes: copyAttributes(attributes) });
			} catch {
				// Recording is passive. Ignore malformed or unreadable telemetry payloads.
			}
		},
		setAttributes(attributes) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.attributes = mergeAttributes(recordedSpan.attributes, attributes);
			} catch {
				// Recording is passive. Ignore malformed or unreadable telemetry payloads.
			}
		},
		setStatus(status) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.status = copyStatus(status);
				recordedSpan.explicitStatus = true;
			} catch {
				// Recording is passive. Ignore malformed or unreadable telemetry payloads.
			}
		},
	};

	let result: T | Promise<T>;
	try {
		result = callback(span);
	} catch (error) {
		settleSpan(state, recordedSpan, true, error);
		return Promise.reject(error);
	}

	return Promise.resolve(result).then(
		(value) => {
			settleSpan(state, recordedSpan, false);
			return value;
		},
		(error: unknown) => {
			settleSpan(state, recordedSpan, true, error);
			throw error;
		},
	);
}

/**
 * Backend-neutral reference implementation that records spans in process memory.
 * Create a fresh instance to isolate tests or independent recording scopes.
 */
export class InMemoryTelemetryContext implements TelemetryContext {
	private readonly state: InMemoryTelemetryState;

	constructor(options: InMemoryTelemetryContextOptions = {}) {
		const maxSpans = options.maxSpans ?? Number.POSITIVE_INFINITY;
		if (maxSpans !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxSpans) || maxSpans < 1)) {
			throw new RangeError("maxSpans must be a positive safe integer");
		}
		this.state = {
			spans: [],
			nextSpanId: 1,
			nextEndSequence: 1,
			maxSpans,
			droppedSpanCount: 0,
		};
	}

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return startInMemorySpan(this.state, undefined, options, callback);
	}

	/** Returns detached snapshots in span-start order. */
	getSpans(): readonly RecordedTelemetrySpan[] {
		return this.state.spans.map((span) => ({
			id: span.id,
			parentId: span.parentId,
			name: span.name,
			attributes: copyAttributes(span.attributes),
			events: span.events.map((event) => ({
				name: event.name,
				attributes: copyAttributes(event.attributes),
			})),
			status: copyStatus(span.status),
			settled: span.settled,
			...(span.endSequence === undefined ? {} : { endSequence: span.endSequence }),
		}));
	}

	/**
	 * Return each retained settled span after a caller-owned cursor at most once.
	 *
	 * The returned cursor advances across all settlements, including spans already
	 * evicted from the bounded buffer. A higher dropped count tells the caller the
	 * retained result is incomplete and must not be treated as a full history.
	 */
	getSettledSpansAfter(endSequence = 0): SettledTelemetrySpanSnapshot {
		if (!Number.isSafeInteger(endSequence) || endSequence < 0) {
			throw new RangeError("endSequence must be a non-negative safe integer");
		}
		const spans = this.getSpans()
			.filter(
				(span): span is RecordedTelemetrySpan & { readonly endSequence: number } =>
					span.settled && span.endSequence !== undefined && span.endSequence > endSequence,
			)
			.sort((left, right) => left.endSequence - right.endSequence);
		return {
			cursor: Math.max(endSequence, this.state.nextEndSequence - 1),
			spans,
			droppedSpanCount: this.state.droppedSpanCount,
		};
	}

	/** Number of spans evicted or declined because the configured capacity was full. */
	getDroppedSpanCount(): number {
		return this.state.droppedSpanCount;
	}
}
