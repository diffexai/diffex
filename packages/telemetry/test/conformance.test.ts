import { describe, expect, it } from "vitest";
import { InMemoryTelemetryContext, type SpanAttributes } from "../src/index.ts";
import { createTelemetryAdapterConformance, type TelemetryAdapterFixture } from "../src/testing/index.ts";

const conformance = createTelemetryAdapterConformance(() => {
	const context = new InMemoryTelemetryContext();
	return Promise.resolve<TelemetryAdapterFixture>({
		context,
		getSpans: () => Promise.resolve(context.getSpans()),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	});
});

describe("InMemoryTelemetryContext conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}

	it("returns detached snapshots without exposing mutable recording state", async () => {
		const context = new InMemoryTelemetryContext();
		let openSettled: boolean | undefined;
		let openEndSequence: number | undefined;
		await context.startSpan({ name: "snapshot", attributes: { tags: ["initial"] } }, (span) => {
			span.addEvent("event", { value: 1 });
			const [open] = context.getSpans();
			openSettled = open?.settled;
			openEndSequence = open?.endSequence;
		});

		expect(openSettled).toBe(false);
		expect(openEndSequence).toBeUndefined();
		const [first] = context.getSpans();
		expect(first?.settled).toBe(true);
		expect(first?.endSequence).toBe(1);
		(first?.attributes as SpanAttributes).tags = ["mutated"];
		(first?.events[0]?.attributes as SpanAttributes).value = 2;

		const [second] = context.getSpans();
		expect(second?.attributes).toEqual({ tags: ["initial"] });
		expect(second?.events).toEqual([{ name: "event", attributes: { value: 1 } }]);
	});

	it("bounds retained spans without interrupting instrumented work", async () => {
		const context = new InMemoryTelemetryContext({ maxSpans: 2 });
		for (const name of ["first", "second", "third"]) {
			await context.startSpan({ name }, () => name);
		}

		expect(context.getSpans().map((span) => span.name)).toEqual(["second", "third"]);
		expect(context.getDroppedSpanCount()).toBe(1);

		let childRan = false;
		await context.startSpan({ name: "parent" }, async (parent) => {
			await Promise.all([
				parent.startSpan({ name: "child-one" }, () => {
					childRan = true;
				}),
				parent.startSpan({ name: "child-two" }, () => {
					childRan = true;
				}),
			]);
		});
		expect(childRan).toBe(true);
		expect(context.getSpans()).toHaveLength(2);
		expect(context.getDroppedSpanCount()).toBeGreaterThanOrEqual(2);
	});

	it("reads newly settled spans once with an advancing cursor", async () => {
		const context = new InMemoryTelemetryContext({ maxSpans: 2 });
		await context.startSpan({ name: "first" }, () => {});
		const first = context.getSettledSpansAfter();
		expect(first.cursor).toBe(1);
		expect(first.spans.map((span) => span.name)).toEqual(["first"]);

		expect(context.getSettledSpansAfter(first.cursor)).toEqual({
			cursor: first.cursor,
			spans: [],
			droppedSpanCount: 0,
		});

		await context.startSpan({ name: "second" }, () => {});
		await context.startSpan({ name: "third" }, () => {});
		const next = context.getSettledSpansAfter(first.cursor);
		expect(next.cursor).toBe(3);
		expect(next.spans.map((span) => span.name)).toEqual(["second", "third"]);
		expect(next.droppedSpanCount).toBe(1);
		expect(context.getSettledSpansAfter(next.cursor).spans).toEqual([]);
	});

	it("does not advance the cursor past work that is still open", async () => {
		const context = new InMemoryTelemetryContext();
		let finish: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const pending = context.startSpan({ name: "pending" }, () => gate);

		const open = context.getSettledSpansAfter();
		expect(open).toEqual({ cursor: 0, spans: [], droppedSpanCount: 0 });

		finish?.();
		await pending;
		const settled = context.getSettledSpansAfter(open.cursor);
		expect(settled.cursor).toBe(1);
		expect(settled.spans.map((span) => span.name)).toEqual(["pending"]);
	});

	it("rejects invalid span capacities", () => {
		expect(() => new InMemoryTelemetryContext({ maxSpans: 0 })).toThrow(RangeError);
		expect(() => new InMemoryTelemetryContext({ maxSpans: 1.5 })).toThrow(RangeError);
		expect(() => new InMemoryTelemetryContext().getSettledSpansAfter(-1)).toThrow(RangeError);
	});
});
