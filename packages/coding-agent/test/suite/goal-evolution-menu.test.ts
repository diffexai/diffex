import { setKeybindings, visibleWidth } from "@diffexai/diffex-tui";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD, type EvolutionOverview } from "#evolution";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import {
	type EvolutionMenuClient,
	EvolutionMenuComponent,
} from "../../src/modes/interactive/components/evolution-menu.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const overview: EvolutionOverview = {
	scope: { repositoryId: "repository", scopeId: "repository" },
	processedEvidenceCursor: 0,
	ingestionHighWaterCursor: 0,
	unprocessedTokens: 0,
	settledInvocationCount: 0,
	automaticTokenThreshold: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
	automaticMinimumInvocations: 5,
	lastEvolutionAt: null,
	cooldownRemainingMs: 0,
	automaticEligibility: { eligible: false, reason: "insufficient-tokens" },
	activeJob: null,
	newestResumableJob: null,
	currentHarnessVersion: null,
	observedHarnessVersion: null,
	nextPromptWillRefresh: false,
	rollbackAction: null,
};

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

it("shows why enabling evolution is blocked and allows it after leaving goal mode", async () => {
	let goalSuspended = true;
	let enabled = false;
	const setEnabled = vi.fn(async (value: boolean) => {
		enabled = value;
	});
	const client = {
		getEnabled: () => enabled,
		getGoalSuspended: () => goalSuspended,
		setEnabled,
		subscribe: () => () => {},
		overview: async () => overview,
		listHarnessVersionInfo: async () => [],
	} as unknown as EvolutionMenuClient;
	const component = new EvolutionMenuComponent(
		client,
		() => {},
		() => {},
		() => {},
	);
	try {
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(100).join("\n"))).toContain("Toggle [off] [disable /goal first]"),
		);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("Disable /goal to enable it.");
		for (const line of component.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		for (let index = 0; index < 6; index++) component.handleInput("\u001b[B");
		component.handleInput("\n");
		expect(setEnabled).not.toHaveBeenCalled();
		goalSuspended = false;
		component.handleInput("\u001b[A");
		component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true));
		expect(enabled).toBe(true);
	} finally {
		component.dispose();
	}
});

it("shows an existing evolution preference as paused and still allows disabling it", async () => {
	let enabled = true;
	const setEnabled = vi.fn(async (value: boolean) => {
		enabled = value;
	});
	const startManual = vi.fn();
	const client = {
		getEnabled: () => enabled,
		getGoalSuspended: () => true,
		setEnabled,
		startManual,
		subscribe: () => () => {},
		overview: async () => overview,
		listHarnessVersionInfo: async () => [],
	} as unknown as EvolutionMenuClient;
	const component = new EvolutionMenuComponent(
		client,
		() => {},
		() => {},
		() => {},
	);
	try {
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(100).join("\n"))).toContain("Next automatic evolution: Paused by goal mode"),
		);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("Evolve [unavailable]");
		expect(stripAnsi(component.render(100).join("\n"))).toContain("Browse [unavailable]");
		component.handleInput("\u001b[B");
		component.handleInput("\n");
		expect(startManual).not.toHaveBeenCalled();
		for (let index = 0; index < 5; index++) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
		expect(enabled).toBe(false);
	} finally {
		component.dispose();
	}
});
