import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvolutionJobDetail, EvolutionJobSummary, EvolutionOverview, EvolutionProgressEvent } from "#evolution";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type EvolutionMenuClient,
	EvolutionMenuComponent,
	formatEvolutionTimestamp,
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

function jobDetail(overrides: Partial<EvolutionJobDetail> = {}): EvolutionJobDetail {
	return {
		...job(),
		evidenceHighWaterCursor: 8,
		completedSlices: 3,
		discoveredSlices: 4,
		modelCalls: 5,
		modelRetries: 1,
		emittedProposals: 2,
		eligibleProposals: 1,
		selectedOperations: 1,
		lastCheckpointAt: "2026-08-20T12:34:00.000Z",
		errorMessage: null,
		baseHarnessVersion: rootVersion,
		activatedHarnessVersion: null,
		nextPromptWillRefresh: false,
		proposalIds: [],
		observability: {
			queueAgeMs: 10,
			stageLatencies: [{ stage: "reflecting", durationMs: 20 }],
			estimatedEvidenceTokens: 12_345,
			providerCostUsd: null,
			reflectorBudget: { modelCalls: 5, reflectionRounds: 2, toolCalls: 3 },
			sliceCoverage: { analyzed: 3, corrupt: 0, skipped: 1, unreadable: 0 },
			proposalDispositions: {
				applied: 0,
				deferred: 0,
				failed: 0,
				quarantined: 0,
				rejected: 0,
				"rolled-back": 0,
				superseded: 0,
				unselected: 1,
			},
			activationConflicts: 0,
			rollbackAvailable: false,
			recoveryAttempts: 1,
		},
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
		lastEvolutionAt: null,
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
	listJobs: ReturnType<typeof vi.fn>;
	jobDetailCall: ReturnType<typeof vi.fn>;
} {
	let listener: ((event: EvolutionProgressEvent) => void) | undefined;
	const unsubscribed = vi.fn();
	const startManual = vi.fn().mockResolvedValue({ status: "created", job: job() });
	const overviewCall = vi.fn().mockResolvedValue(currentOverview);
	const listJobs = vi.fn().mockResolvedValue([]);
	const jobDetailCall = vi.fn().mockRejectedValue(new Error("unused"));
	return {
		client: {
			subscribe: (next) => {
				listener = next;
				return unsubscribed;
			},
			overview: overviewCall,
			listJobs,
			jobDetail: jobDetailCall,
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
		listJobs,
		jobDetailCall,
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
		fixture.jobDetailCall.mockResolvedValue(jobDetail());
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
		expect(output).toContain("Last evolution: never");
		expect(output).toContain("Next automatic evolution: blocking-job");
		expect(output.indexOf("Next automatic evolution")).toBeLessThan(output.indexOf("Cooldown"));
		expect(output).not.toContain("Evidence scope");
		expect(output).not.toContain("Automatic threshold");
		expect(output).not.toContain("Selected harness");
		expect(output).toContain("Refresh");
		expect(output).toContain("Evolve [Started]");
		expect(output).toContain("View");
		expect(output).not.toContain("View [unavailable]");
		expect(output).toContain("Resume [unavailable]");
		expect(output).toContain("Browse");
		expect(output).toContain("Rollback [unavailable]");
		expect(output).toContain("Cancel");

		component.handleInput("\u001b[B");
		component.handleInput("\n");
		expect(fixture.startManual).not.toHaveBeenCalled();
		component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall).toHaveBeenCalledWith("job-active"));
		component.dispose();
	});

	it("describes insufficient automatic evidence in user-facing language", async () => {
		const terminalAt = new Date();
		terminalAt.setHours(11, 10, 0, 0);
		const fixture = client(
			overview({
				automaticEligibility: { eligible: false, reason: "insufficient-tokens" },
				lastEvolutionAt: terminalAt.toISOString(),
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
		expect(output).toContain("Last evolution: Today at 11:10 am");
		expect(output).toContain("Next automatic evolution: Insufficient information");
		expect(output).toContain("Evolve");
		expect(output).toContain("View [unavailable]");
		expect(output).toContain("Resume [unavailable]");
		expect(output).toContain("Browse");
		expect(output).toContain("Rollback [unavailable]");
		expect(output).toContain("Cancel [unavailable]");
	});

	it("polls durable job state and explains a reflection failure without false zero coverage", async () => {
		const terminalAt = new Date();
		terminalAt.setHours(13, 25, 0, 0);
		const fixture = client(
			overview({
				activeJob: job(),
				automaticEligibility: { eligible: false, reason: "blocking-job" },
			}),
		);
		const activeDetail = jobDetail({
			emittedProposals: 0,
			eligibleProposals: 0,
			observability: { ...jobDetail().observability, sliceCoverage: null },
		});
		const failedDetail = jobDetail({
			outcome: "terminal-failed",
			reasonCode: "reflection-invalid-response",
			terminalAt: terminalAt.toISOString(),
			emittedProposals: 0,
			eligibleProposals: 0,
			errorMessage: "Reflector returned an invalid response",
			observability: { ...activeDetail.observability, sliceCoverage: null },
		});
		fixture.listJobs.mockResolvedValue([job()]);
		fixture.jobDetailCall.mockResolvedValueOnce(activeDetail).mockResolvedValue(failedDetail);
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
			5,
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

		for (let index = 0; index < 4; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("job-active"));
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall.mock.calls.length).toBeGreaterThanOrEqual(2));

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Result: Failed during reflection before proposals could be generated");
		expect(output).toContain("Finished: Today at 1:25 pm");
		expect(output).toContain("Coverage: unavailable - reflection did not complete");
		expect(output).toContain("Last error: Reflector returned an invalid response");
		expect(output).not.toContain("Coverage: 0 analyzed");
		component.dispose();
	});

	it("renders a concise browsed job detail", async () => {
		const fixture = client(overview());
		const checkpoint = new Date();
		checkpoint.setHours(9, 5, 0, 0);
		fixture.listJobs.mockResolvedValue([job()]);
		fixture.jobDetailCall.mockResolvedValue(jobDetail({ lastCheckpointAt: checkpoint.toISOString() }));
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

		for (let index = 0; index < 4; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("job-active"));
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall).toHaveBeenCalledWith("job-active"));

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Trigger: manual");
		expect(output).toContain("Stage: reflecting (active)");
		expect(output).toContain("Result: In progress");
		expect(output).toContain("Finished: never");
		expect(output).toContain("Proposals: 2 emitted / 1 eligible");
		expect(output).toContain("Evolution token: 12,345");
		expect(output).toContain("Reflector budget: 5 model / 2 rounds / 3 tools");
		expect(output).toContain("Coverage: 3 analyzed / 0 corrupt / 1 skipped / 0 unreadable");
		expect(output).toContain("Recovery attempts: 1");
		expect(output).toContain("Last checkpoint: Today at 9:05 am");
		expect(output).toContain("Last error: none");
		expect(output).toContain("Base harness: sha256:aaaaaaaaaaaa");
		for (const removedLabel of [
			"Job:",
			"Evidence high-water cursor:",
			"Slices:",
			"Model calls:",
			"Selected operations:",
			"Queue age:",
			"Stage latency:",
			"Evidence tokens:",
			"Provider cost:",
			"Proposal dispositions:",
			"Activation conflicts:",
			"Rollback available:",
			"Activated harness:",
			"Next prompt will refresh:",
		]) {
			expect(output).not.toContain(removedLabel);
		}
	});

	it("formats evolution timestamps for today and earlier dates", () => {
		const now = new Date(2026, 7, 20, 15, 0);
		expect(formatEvolutionTimestamp(new Date(2026, 7, 20, 9, 5).toISOString(), now)).toBe("Today at 9:05 am");
		expect(formatEvolutionTimestamp(new Date(2026, 6, 28, 21, 30).toISOString(), now)).toBe("7/28 at 9:30 pm");
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
