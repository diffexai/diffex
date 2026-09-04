import type { Component } from "@earendil-works/diffex-tui";
import { Container, Text, visibleWidth } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import type { AppKeybinding, KeybindingsConfig } from "../src/core/keybindings.ts";
import { CustomFooterPlanModeIndicator } from "../src/modes/interactive/components/footer.ts";
import { createInteractiveLayout, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type FooterContext = {
	customFooter: (Component & { dispose?(): void }) | undefined;
	footerContainer: Container;
	footer: Component;
	footerDataProvider: ReadonlyFooterDataProvider;
	ui: { requestRender: ReturnType<typeof vi.fn> };
};

type HotkeysContext = {
	getEditorKeyDisplay: () => string;
	getAppKeyDisplay: (action: AppKeybinding) => string;
	session: { extensionRunner: { getShortcuts: (config: KeybindingsConfig) => Map<string, never> } };
	keybindings: { getEffectiveConfig: () => KeybindingsConfig };
	chatContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	getMarkdownThemeWithSettings: typeof getMarkdownTheme;
};

type InteractiveModePrivate = {
	handleHotkeysCommand(this: HotkeysContext): void;
	renderWidgetContainer(
		this: unknown,
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		leadingSpacer: boolean,
		trailingComponent?: Component,
	): void;
	setExtensionFooter(
		this: FooterContext,
		factory:
			| ((tui: unknown, theme: unknown, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createFooterContext(): FooterContext {
	return {
		customFooter: undefined,
		footerContainer: new Container(),
		footer: new Text("built-in footer"),
		footerDataProvider: {} as ReadonlyFooterDataProvider,
		ui: { requestRender: vi.fn() },
	};
}

function renderHotkeys(bindings: Partial<Record<AppKeybinding, string>>): string {
	const context: HotkeysContext = {
		getEditorKeyDisplay: () => "Key",
		getAppKeyDisplay: (action) => bindings[action] ?? "Key",
		session: { extensionRunner: { getShortcuts: () => new Map<string, never>() } },
		keybindings: { getEffectiveConfig: () => ({}) },
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		getMarkdownThemeWithSettings: getMarkdownTheme,
	};

	prototype.handleHotkeysCommand.call(context);
	return stripAnsi(context.chatContainer.render(160).join("\n"));
}

describe("Plan mode presentation", () => {
	beforeAll(() => initTheme("dark"));

	it("shows a separate Plan row only while a custom footer is active in Plan mode", () => {
		let mode: "default" | "plan" = "plan";
		const context = createFooterContext();
		const indicator = new CustomFooterPlanModeIndicator(() => context.customFooter !== undefined && mode === "plan");
		const customFooter = new Text("custom footer");

		expect(indicator.render(80)).toEqual([]);

		prototype.setExtensionFooter.call(context, () => customFooter);
		const planLine = indicator.render(80)[0] ?? "";
		expect(stripAnsi(planLine)).toBe("Plan mode");
		expect(planLine).toContain(theme.fg("warning", "Plan mode"));
		expect(context.footerContainer.children).toEqual([customFooter]);

		mode = "default";
		expect(indicator.render(80)).toEqual([]);
		prototype.setExtensionFooter.call(context, undefined);
		expect(context.footerContainer.children).toEqual([context.footer]);
	});

	it("keeps the custom-footer Plan row directly above the editor in regular and fullscreen layouts", () => {
		const widgetAbove = new Container();
		const indicator = new CustomFooterPlanModeIndicator(() => true);
		prototype.renderWidgetContainer.call(undefined, widgetAbove, new Map(), true, indicator);
		const editor = new Text("editor");
		const footer = new Text("custom footer");
		const document = new Text("conversation");
		const transcript = new Container();
		transcript.addChild(document);
		const layout = createInteractiveLayout({
			document,
			transcript,
			pendingMessages: new Container(),
			status: new Container(),
			widgetAbove,
			editor,
			widgetBelow: new Container(),
			footer,
		});

		const regularLines = layout.regularComponents
			.flatMap((component) => component.render(80))
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		const fullscreenLines = layout.fullscreenRoot
			.render(80)
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean);
		for (const lines of [regularLines, fullscreenLines]) {
			const editorIndex = lines.indexOf("editor");
			expect(lines[editorIndex - 1]).toBe("Plan mode");
			expect(lines.indexOf("custom footer")).toBeGreaterThan(editorIndex);
		}
	});

	it("truncates the custom-footer Plan row to its available width", () => {
		const indicator = new CustomFooterPlanModeIndicator(() => true);

		const line = indicator.render(3)[0] ?? "";

		expect(visibleWidth(line)).toBeLessThanOrEqual(3);
		expect(stripAnsi(line)).not.toBe("");
	});

	it("lists the mode toggle and accurately marks thinking cycling as unbound", () => {
		const hotkeys = renderHotkeys({
			"app.mode.toggle": "Shift+Tab",
			"app.thinking.cycle": "",
		});

		expect(hotkeys).toContain("Shift+Tab");
		expect(hotkeys).toContain("Toggle collaboration mode");
		expect(hotkeys).toContain("Unbound");
		expect(hotkeys).toContain("Cycle thinking level");
	});

	it("shows configured mode and thinking bindings in /hotkeys", () => {
		const hotkeys = renderHotkeys({
			"app.mode.toggle": "Ctrl+M",
			"app.thinking.cycle": "Shift+Tab",
		});

		expect(hotkeys).toContain("Ctrl+M");
		expect(hotkeys).toContain("Shift+Tab");
		expect(hotkeys).not.toContain("Unbound");
	});
});
