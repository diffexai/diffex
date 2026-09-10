import { sep } from "node:path";
import type { HarnessVersion } from "@diffexai/diffex-harness-state";
import { setKeybindings, visibleWidth } from "@diffexai/diffex-tui";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
	type EvolutionHarnessVersionInfo,
	type EvolutionOverview,
} from "#evolution";
import type { AgentSession } from "../src/core/agent-session.ts";
import { type CollaborationMode, GET_COLLABORATION_MODE } from "../src/core/collaboration-mode.ts";
import type { EvolutionRuntimeEvent } from "../src/core/evolution-runtime.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { EvolutionFooterStatusClient } from "../src/modes/interactive/components/evolution-footer-status.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { formatEvolutionTimestamp } from "../src/modes/interactive/components/harness-version-display.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const originalNoColor = process.env.NO_COLOR;

afterAll(() => {
	if (originalNoColor === undefined) {
		delete process.env.NO_COLOR;
	} else {
		process.env.NO_COLOR = originalNoColor;
	}
	initTheme("dark", false);
});

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	activeHarnessVersion?: string;
	mode?: CollaborationMode;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
		activeHarnessVersion: options.activeHarnessVersion,
		[GET_COLLABORATION_MODE]: () => options.mode ?? "default",
	};

	return session as unknown as AgentSession;
}

function createEvolutionClient(
	currentOverview: EvolutionOverview,
	versionInfo: readonly EvolutionHarnessVersionInfo[],
	enabled = true,
): EvolutionFooterStatusClient {
	return {
		getEnabled: () => enabled,
		subscribe: (_listener: (event: EvolutionRuntimeEvent) => void) => () => {},
		overview: async () => currentOverview,
		listHarnessVersionInfo: async () => versionInfo,
	};
}

function evolutionOverview(
	currentHarnessVersion: HarnessVersion,
	activeJob: EvolutionOverview["activeJob"] = null,
): EvolutionOverview {
	return {
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
		activeJob,
		newestResumableJob: null,
		currentHarnessVersion,
		observedHarnessVersion: currentHarnessVersion,
		nextPromptWillRefresh: false,
		rollbackAction: null,
	};
}

function createFooterData(
	providerCount: number,
	extensionStatuses: ReadonlyMap<string, string> = new Map(),
): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe(`~${sep}project`);
	});
});

describe("FooterComponent width handling", () => {
	beforeEach(() => {
		process.env.NO_COLOR = "";
		initTheme(undefined, false);
		setKeybindings(new KeybindingsManager());
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows model, thinking, context, and harness on one priority row", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5.5",
			thinkingLevel: "medium",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(120).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("gpt-5.5");
		expect(lines[0]).toContain("thinking medium");
		expect(lines[0]).toContain("context 12.3% / 200k");
		expect(lines[0]).toContain("harness default");
		expect(lines[0]).toContain("/hotkeys");
	});

	it("uses dedicated colors for footer model, context usage, and context window", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5.5",
			thinkingLevel: "medium",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = footer.render(120)[0];
		expect(statsLine).toContain(theme.fg("footerModel", "gpt-5.5"));
		expect(statsLine).toContain(theme.fg("thinkingText", "thinking medium"));
		expect(statsLine).toContain(theme.fg("footerContext", "context 12.3%"));
		expect(statsLine).toContain(theme.fg("footerWindow", "200k"));
	});

	it("shows a highest-priority warning-colored Plan identity on the single footer row", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5.5",
			thinkingLevel: "medium",
			mode: "plan",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(120);
		const line = stripAnsi(lines[0] ?? "");

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(theme.fg("warning", "Plan mode"));
		expect(line).toContain("gpt-5.5");
		expect(line).toContain("context 12.3% / 200k");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(120);
	});

	it("keeps the full Plan identity ahead of lower-priority footer fields", () => {
		const session = createSession({ sessionName: "", modelId: "model", mode: "plan" });
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(18)[0] ?? "");

		expect(line).toContain("Plan mode");
		expect(line).toContain("model");
		expect(line).not.toContain("12%");
		expect(visibleWidth(line)).toBeLessThanOrEqual(18);
	});

	it("compacts and then truncates the Plan identity at narrow widths", () => {
		const session = createSession({ sessionName: "", modelId: "model", mode: "plan" });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(8)[0] ?? "")).toContain("Plan");
		expect(stripAnsi(footer.render(8)[0] ?? "")).not.toContain("Plan mode");
		expect(stripAnsi(footer.render(4)[0] ?? "")).toBe("Plan");
		expect(visibleWidth(footer.render(3)[0] ?? "")).toBeLessThanOrEqual(3);
		expect(stripAnsi(footer.render(3)[0] ?? "")).not.toBe("");
	});

	it("does not add collaboration identity to the Default footer", () => {
		const session = createSession({ sessionName: "", modelId: "gpt-5.5", mode: "default" });
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(120)[0] ?? "");

		expect(line).not.toContain("Plan");
		expect(line).toContain("gpt-5.5");
		expect(line).toContain("context 12.3% / 200k");
	});

	it("keeps model and context visible instead of truncating the full row at narrow widths", () => {
		const session = createSession({
			sessionName: "",
			modelId: "very-long-model-name-that-needs-compacting",
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(32);
		const line = stripAnsi(lines[0] ?? "");

		expect(lines).toHaveLength(1);
		expect(line).toContain("very-long");
		expect(line).toContain("12%");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(32);
	});

	it("derives wide-screen hints from configured keybindings", () => {
		setKeybindings(
			new KeybindingsManager({
				"app.thinking.cycle": "alt+t",
				"app.model.cycleForward": "alt+m",
			}),
		);
		const session = createSession({ sessionName: "", modelId: "gpt-5.5", thinkingLevel: "medium" });
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(160)[0] ?? "");

		const altKey = process.platform === "darwin" ? "option" : "alt";
		expect(line).toContain(`${altKey}+t thinking`);
		expect(line).toContain(`${altKey}+m model`);
		expect(line).toContain("/hotkeys");
	});

	it("keeps extension statuses on the same row when space permits", () => {
		const session = createSession({ sessionName: "", modelId: "gpt-5.5", thinkingLevel: "medium" });
		const footer = new FooterComponent(session, createFooterData(1, new Map([["review", "review ready"]])));

		const lines = footer.render(160).map(stripAnsi);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("review ready");
	});

	it("prioritizes extension statuses over optional hints at standard width", () => {
		const session = createSession({
			sessionName: "",
			modelId: "claude-opus-4-8",
			thinkingLevel: "medium",
		});
		const footer = new FooterComponent(session, createFooterData(1, new Map([["review", "review ready"]])));

		const line = stripAnsi(footer.render(80)[0] ?? "");

		expect(line).toContain("claude-opus-4-8");
		expect(line).toContain("12.3%");
		expect(line).toContain("review ready");
		expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it("shows the active evolved harness completion time", async () => {
		const version = `sha256:${"b".repeat(64)}` as HarnessVersion;
		const evolvedAt = new Date();
		evolvedAt.setHours(12, 48, 0, 0);
		const session = createSession({ sessionName: "", activeHarnessVersion: version });
		const footer = new FooterComponent(session, createFooterData(1), {
			evolution: createEvolutionClient(evolutionOverview(version), [
				{
					version,
					kind: "evolved",
					evolvedAt: evolvedAt.toISOString(),
					evolvedIn: "/projects/diffex",
				},
			]),
		});

		await vi.waitFor(() => {
			expect(stripAnsi(footer.render(200)[0])).toContain(
				`harness ${formatEvolutionTimestamp(evolvedAt.toISOString())}`,
			);
		});
		footer.dispose();
	});

	it("shows a spinner to the right of the harness time while evolution runs", async () => {
		const version = `sha256:${"b".repeat(64)}` as HarnessVersion;
		const evolvedAt = new Date().toISOString();
		const activeJob = {
			jobId: "job-active",
			trigger: "automatic",
			stage: "reflecting",
			outcome: "active",
			reasonCode: null,
			analysisStatus: "processing",
			candidateGeneration: {
				status: "not-applicable",
				stage: null,
				updatedAt: null,
				attempt: 0,
				retryNotBefore: null,
				failureMessage: null,
			},
			createdAt: evolvedAt,
			updatedAt: evolvedAt,
			terminalAt: null,
			resumable: false,
			cancellable: true,
		} satisfies NonNullable<EvolutionOverview["activeJob"]>;
		const session = createSession({ sessionName: "", activeHarnessVersion: version });
		const footer = new FooterComponent(session, createFooterData(1), {
			evolution: createEvolutionClient(evolutionOverview(version, activeJob), [
				{ version, kind: "evolved", evolvedAt, evolvedIn: "/projects/diffex" },
			]),
		});

		await vi.waitFor(() => {
			const footerLine = stripAnsi(footer.render(200)[0]);
			expect(footerLine).toMatch(new RegExp(`harness ${formatEvolutionTimestamp(evolvedAt)} [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]`));
		});
		footer.dispose();
	});

	it("hides the evolution spinner while evolution is disabled", async () => {
		const version = `sha256:${"b".repeat(64)}` as HarnessVersion;
		const evolvedAt = new Date().toISOString();
		const activeJob = {
			jobId: "job-active",
			trigger: "automatic",
			stage: "reflecting",
			outcome: "active",
			reasonCode: null,
			analysisStatus: "processing",
			candidateGeneration: {
				status: "not-applicable",
				stage: null,
				updatedAt: null,
				attempt: 0,
				retryNotBefore: null,
				failureMessage: null,
			},
			createdAt: evolvedAt,
			updatedAt: evolvedAt,
			terminalAt: null,
			resumable: false,
			cancellable: true,
		} satisfies NonNullable<EvolutionOverview["activeJob"]>;
		const session = createSession({ sessionName: "", activeHarnessVersion: version });
		const footer = new FooterComponent(session, createFooterData(1), {
			evolution: createEvolutionClient(
				evolutionOverview(version, activeJob),
				[{ version, kind: "evolved", evolvedAt, evolvedIn: "/projects/diffex" }],
				false,
			),
		});

		await vi.waitFor(() => {
			const footerLine = stripAnsi(footer.render(200)[0] ?? "");
			expect(footerLine).toContain(`harness ${formatEvolutionTimestamp(evolvedAt)}`);
			expect(footerLine).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		});
		footer.dispose();
	});

	it("does not show the project directory in the footer", () => {
		const session = createSession({
			sessionName: "work",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120).join("\n"))).not.toContain("/tmp/project");
	});
});
