import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvolutionJobSummary, EvolutionOverview, EvolutionProgressEvent } from "#evolution";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type EvolutionMenuClient,
	EvolutionMenuComponent,
	sanitizeEvolutionText,
} from "../src/modes/interactive/components/evolution-menu.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const rootVersion = `sha256:${"a".repeat(64)}` as HarnessVersion;

function job(overrides: Partial<EvolutionJobSummary> = {}): EvolutionJobSummary {
	return {
		jobId: "job-active",
		trigger: "manual",
		stage: "reflecting",
		outcome: "active",
		reasonCode: null,
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:01:00.000Z",
		terminalAt: null,
		resumable: false,
		cancellable: true,
		...overrides,
	};
}

function overview(overrides: Partial<EvolutionOverview> = {}): EvolutionOverview {
	return {
		scope: { repositoryId: "repository", scopeId: "repository" },
		processedEvidenceCursor: 2,
		ingestionHighWaterCursor: 8,
		unprocessedEstimatedTokens: 1_100_001,
		settledInvocationCount: 6,
		automaticTokenThreshold: 1_000_000,
		automaticMinimumInvocations: 5,
		lastAutomaticRunAt: null,
		cooldownRemainingMs: 0,
		automaticEligibility: { eligible: true },
		activeJob: null,
		newestResumableJob: null,
		currentHarnessVersion: rootVersion,
		observedHarnessVersion: rootVersion,
		nextPromptWillRefresh: false,
		rollbackAction: null,
		...overrides,
	};
}

function client(currentOverview: EvolutionOverview): {
	client: EvolutionMenuClient;
	emit: (event: EvolutionProgressEvent) => void;
	unsubscribed: ReturnType<typeof vi.fn>;
	startManual: ReturnType<typeof vi.fn>;
	overviewCall: ReturnType<typeof vi.fn>;
} {
	let listener: ((event: EvolutionProgressEvent) => void) | undefined;
	const unsubscribed = vi.fn();
	const startManual = vi.fn().mockResolvedValue({ status: "created", job: job() });
	const overviewCall = vi.fn().mockResolvedValue(currentOverview);
	return {
		client: {
			subscribe: (next) => {
				listener = next;
				return unsubscribed;
			},
			overview: overviewCall,
			listJobs: vi.fn().mockResolvedValue([]),
			jobDetail: vi.fn().mockRejectedValue(new Error("unused")),
			proposalDetail: vi.fn().mockRejectedValue(new Error("unused")),
			startManual,
			resumeNewest: vi.fn().mockRejectedValue(new Error("unused")),
			cancelActive: vi.fn().mockRejectedValue(new Error("unused")),
			rollback: vi.fn().mockRejectedValue(new Error("unused")),
		},
		emit: (event) => listener?.(event),
		unsubscribed,
		startManual,
		overviewCall,
	};
}

describe("EvolutionMenuComponent", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("renders automatic eligibility and durable disabled actions", async () => {
		const active = job();
		const fixture = client(
			overview({
				activeJob: active,
				automaticEligibility: { eligible: false, reason: "blocking-job" },
			}),
		);
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalled());

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Evolution tokens: 1,100,001");
		expect(output).toContain("Evolution invocations: 6");
		expect(output).toContain("Last automatic evolution: never");
		expect(output).toContain("Next automatic evolution: blocking-job");
		expect(output.indexOf("Next automatic evolution")).toBeLessThan(output.indexOf("Cooldown"));
		expect(output).not.toContain("Evidence scope");
		expect(output).not.toContain("Automatic threshold");
		expect(output).not.toContain("Selected harness");
		expect(output).toContain("Refresh");
		expect(output).toContain("Evolve [unavailable]");
		expect(output).toContain("View");
		expect(output).toContain("Resume [unavailable]");
		expect(output).toContain("Browse");
		expect(output).toContain("Rollback [unavailable]");
		expect(output).toContain("Cancel");
	});

	it("describes insufficient automatic evidence in user-facing language", async () => {
		const fixture = client(overview({ automaticEligibility: { eligible: false, reason: "insufficient-tokens" } }));
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalled());

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Next automatic evolution: Insufficient information");
		expect(output).toContain("Evolve");
		expect(output).toContain("View [unavailable]");
		expect(output).toContain("Resume [unavailable]");
		expect(output).toContain("Browse");
		expect(output).toContain("Rollback [unavailable]");
		expect(output).toContain("Cancel [unavailable]");
	});

	it("confirms a manual start before invoking the control service", async () => {
		const fixture = client(overview());
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Evolve"));

		component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(160).join("\n"))).toContain(
				"Would you like Diffex to evolve based on the information it has collected?",
			),
		);
		expect(stripAnsi(component.render(160).join("\n"))).toContain("This process will run in the background.");
		expect(fixture.startManual).not.toHaveBeenCalled();

		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.startManual).toHaveBeenCalledOnce());
	});

	it("reports when a manual start has no settled evidence", async () => {
		const fixture = client(overview());
		fixture.startManual.mockResolvedValue({ status: "not-created", reason: "no-new-evidence" });
		const status = vi.fn();
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			status,
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Evolve"));

		component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(160).join("\n"))).toContain(
				"Would you like Diffex to evolve based on the information it has collected?",
			),
		);
		component.handleInput("\n");

		await vi.waitFor(() => expect(status).toHaveBeenCalledWith("No new settled evidence is available", false));
	});

	it("pops a nested view before closing and disposes its progress subscription", async () => {
		const fixture = client(overview());
		const close = vi.fn();
		const component = new EvolutionMenuComponent(
			fixture.client,
			close,
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalledOnce());
		component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(160).join("\n"))).toContain(
				"Would you like Diffex to evolve based on the information it has collected?",
			),
		);

		component.handleInput("\u001b");
		expect(close).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Refresh"));
		component.handleInput("\u001b");

		expect(close).toHaveBeenCalledOnce();
		expect(fixture.unsubscribed).toHaveBeenCalledOnce();
	});

	it("refreshes from progress events until disposed", async () => {
		const fixture = client(overview());
		const render = vi.fn();
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			render,
		);
		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalledOnce());
		fixture.emit({
			jobId: "job-active",
			emittedAt: "2026-08-20T00:02:00.000Z",
			type: "checkpoint",
			stage: "reflecting",
		});
		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalledTimes(2));
		expect(render).toHaveBeenCalled();

		component.dispose();
		fixture.emit({
			jobId: "job-active",
			emittedAt: "2026-08-20T00:03:00.000Z",
			type: "completed",
			stage: "completed",
		});
		expect(fixture.overviewCall).toHaveBeenCalledTimes(2);
	});

	it("sanitizes terminal control text", () => {
		expect(sanitizeEvolutionText("unsafe\u001b[2J\rvalue")).toBe("unsafe [2J value");
	});
});
