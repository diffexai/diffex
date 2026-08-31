import { visibleWidth } from "@earendil-works/diffex-tui";
import { describe, expect, test, vi } from "vitest";
import {
	classifyViewport,
	getResponsiveEditorPresentation,
	getResponsiveSectionMaxLines,
	ResponsiveEditorRegion,
	ResponsiveQueuedMessagesComponent,
	ResponsiveSection,
	ResponsiveSpacer,
	ResponsiveViewportRoot,
	TooSmallTerminalComponent,
	type ViewportDimensions,
} from "../src/modes/interactive/responsive-layout.ts";

const identityTheme = {
	title: (text: string) => text,
	detail: (text: string) => text,
	hint: (text: string) => text,
};

describe("classifyViewport", () => {
	test("uses the release breakpoints exactly", () => {
		expect(classifyViewport(121, 12).tier).toBe("wide");
		expect(classifyViewport(120, 12).tier).toBe("standard");
		expect(classifyViewport(80, 12).tier).toBe("standard");
		expect(classifyViewport(79, 12).tier).toBe("narrow");
		expect(classifyViewport(60, 12).tier).toBe("narrow");
		expect(classifyViewport(59, 12).tier).toBe("too-small");
		expect(classifyViewport(200, 11).tier).toBe("too-small");
	});

	test("uses compact density for narrow and short supported terminals", () => {
		expect(classifyViewport(80, 24).compact).toBe(false);
		expect(classifyViewport(80, 23).compact).toBe(true);
		expect(classifyViewport(79, 40).compact).toBe(true);
	});
});

describe("responsive editor allocation", () => {
	test("reserves transcript and dock rows across supported sizes", () => {
		expect(getResponsiveEditorPresentation(classifyViewport(60, 12))).toEqual({
			frameStyle: "top",
			maxVisibleLines: 3,
		});
		expect(getResponsiveEditorPresentation(classifyViewport(60, 24)).maxVisibleLines).toBe(4);
		expect(getResponsiveEditorPresentation(classifyViewport(80, 24)).maxVisibleLines).toBe(5);
		expect(getResponsiveEditorPresentation(classifyViewport(121, 40)).maxVisibleLines).toBe(7);
	});

	test("reapplies presentation when the viewport changes", () => {
		let viewport: ViewportDimensions = { width: 80, height: 24 };
		const component = { render: vi.fn(() => ["editor"]), invalidate: vi.fn() };
		const applyPresentation = vi.fn();
		const region = new ResponsiveEditorRegion(component, () => viewport, applyPresentation);

		expect(region.render(80)).toEqual(["editor"]);
		expect(applyPresentation).toHaveBeenLastCalledWith({ frameStyle: "top", maxVisibleLines: 5 });

		viewport = { width: 60, height: 12 };
		expect(region.render(60)).toEqual(["editor"]);
		expect(applyPresentation).toHaveBeenLastCalledWith({ frameStyle: "top", maxVisibleLines: 3 });
	});
});

describe("responsive layout components", () => {
	test("keeps regular-mode scrollback unbounded at compact widths", () => {
		const compact = classifyViewport(60, 24);

		expect(getResponsiveSectionMaxLines("regular", compact, 2)).toBeUndefined();
		expect(getResponsiveSectionMaxLines("fullscreen", compact, 2)).toBe(2);
		expect(getResponsiveSectionMaxLines("fullscreen", classifyViewport(80, 24), 2)).toBeUndefined();
	});

	test("removes spacer-only widget rows in compact mode", () => {
		let viewport: ViewportDimensions = { width: 80, height: 24 };
		const spacer = new ResponsiveSpacer(() => viewport);
		expect(spacer.render(80)).toEqual([""]);

		viewport = { width: 60, height: 24 };
		expect(spacer.render(60)).toEqual([]);
	});

	test("bounds compact secondary regions without truncating standard content", () => {
		let viewport: ViewportDimensions = { width: 60, height: 12 };
		const component = {
			render: () => ["", "one", "two", "three", "four"],
			invalidate: vi.fn(),
		};
		const region = new ResponsiveSection(component, () => viewport, {
			maxLines: (profile) => (profile.compact ? 1 : undefined),
			retention: "edges",
			trimLeadingBlankWhenCompact: true,
		});

		expect(region.render(60)).toEqual(["one"]);
		viewport = { width: 80, height: 24 };
		expect(region.render(80)).toEqual(["", "one", "two", "three", "four"]);
	});

	test("shows a full-height warning and recovers without replacing normal state", () => {
		let viewport: ViewportDimensions = { width: 40, height: 8 };
		let renderCount = 0;
		const content = {
			render: () => [`normal ${++renderCount}`],
			invalidate: vi.fn(),
		};
		const tooSmall = new TooSmallTerminalComponent(() => viewport, identityTheme);
		const root = new ResponsiveViewportRoot(content, tooSmall, () => viewport);

		const warning = root.render(40);
		expect(warning).toHaveLength(8);
		expect(warning.join("\n")).toContain("Diffex needs more room");
		expect(warning.join("\n")).toContain("minimum 60 x 12");
		expect(warning.join("\n")).toContain("Keys stay active");
		expect(warning.every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(renderCount).toBe(0);

		viewport = { width: 60, height: 12 };
		expect(root.render(60)).toEqual(["normal 1"]);
	});
});

describe("ResponsiveQueuedMessagesComponent", () => {
	test("uses one bounded summary line in compact mode", () => {
		const component = new ResponsiveQueuedMessagesComponent(
			() => ({ steering: ["first", "second"], followUp: ["third"] }),
			() => "Ctrl+Q",
			() => ({ width: 60, height: 24 }),
			{ text: (text) => text },
		);

		const lines = component.render(60);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("3 queued (2 steering, 1 follow-up)");
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(60);
	});

	test("shows two previews, overflow count, and dequeue hint at standard size", () => {
		const component = new ResponsiveQueuedMessagesComponent(
			() => ({ steering: ["first", "second"], followUp: ["third"] }),
			() => "Ctrl+Q",
			() => ({ width: 80, height: 24 }),
			{ text: (text) => text },
		);

		expect(component.render(80)).toEqual([
			"",
			"  Steering: first",
			"  Steering: second",
			"  +1 more queued",
			"  Ctrl+Q to edit queued messages",
		]);
	});
});
