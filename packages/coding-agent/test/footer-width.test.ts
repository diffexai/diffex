import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import { visibleWidth } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
	type EvolutionHarnessVersionInfo,
	type EvolutionOverview,
} from "#evolution";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { EvolutionRuntimeEvent } from "../src/core/evolution-runtime.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import type { EvolutionFooterStatusClient } from "../src/modes/interactive/components/evolution-footer-status.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { formatEvolutionTimestamp } from "../src/modes/interactive/components/harness-version-display.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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
		unprocessedEstimatedTokens: 0,
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

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
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
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
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

	it("shows harness status on a second row aligned below the model", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5.5",
			thinkingLevel: "medium",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const [statsLine, harnessLine] = footer.render(120).map(stripAnsi);
		expect(statsLine).toBe("gpt-5.5 medium • Context 12.3% used • 200k window");
		expect(harnessLine).toBe("Harness default");
		expect(statsLine?.startsWith("gpt-5.5")).toBe(true);
		expect(harnessLine?.startsWith("Harness")).toBe(true);
	});

	it("uses dedicated colors for footer model, context usage, and context window", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5.5",
			thinkingLevel: "medium",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = footer.render(120)[0];
		expect(statsLine).toContain(theme.fg("footerModel", "gpt-5.5 medium"));
		expect(statsLine).toContain(theme.fg("footerContext", "Context 12.3% used"));
		expect(statsLine).toContain(theme.fg("footerWindow", "200k window"));
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
			expect(stripAnsi(footer.render(200)[1])).toBe(`Harness ${formatEvolutionTimestamp(evolvedAt.toISOString())}`);
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
			const harnessLine = stripAnsi(footer.render(200)[1]);
			expect(harnessLine).toMatch(new RegExp(`Harness ${formatEvolutionTimestamp(evolvedAt)} [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]`));
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
			expect(stripAnsi(footer.render(200)[1])).toBe(`Harness ${formatEvolutionTimestamp(evolvedAt)}`);
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
