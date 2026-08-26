import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	EvolutionJobDetail,
	EvolutionJobSummary,
	EvolutionMemoryProposal,
	EvolutionOverview,
	EvolutionProgressEvent,
	EvolutionProposalDetail,
} from "#evolution";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type EvolutionMenuClient,
	EvolutionMenuComponent,
	formatEvolutionEvidencePreview,
	formatEvolutionJobLabel,
	formatEvolutionProposalLabel,
	formatEvolutionProposalOutcome,
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
		baseHarnessInfo: {
			version: rootVersion,
			kind: "default",
			evolvedAt: null,
			evolvedIn: null,
		},
		activatedHarnessVersion: null,
		nextPromptWillRefresh: false,
		proposalIds: [],
		proposals: [],
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

function proposalDetail(): EvolutionProposalDetail {
	const proposalId = "proposal-focused-verification";
	const proposal: EvolutionMemoryProposal = {
		metadata: {
			schemaVersion: 1,
			artifactId: proposalId,
			producer: { name: "test-curator", version: "1.0.0", promptVersion: "curator-v1", model: null },
			sourceIds: ["lesson-1"],
			contentDigest: `sha256:${"b".repeat(64)}`,
			scope: { repositoryId: "repository", scopeId: "repository" },
			createdAt: "2026-08-20T00:00:00.000Z",
		},
		proposalId,
		scope: {
			repository: { repositoryId: "repository", scopeId: "repository" },
			repositoryRevision: "abc123",
			materializationIds: ["materialization-1"],
			traceIds: ["trace-1"],
			sessionIds: ["session-1"],
			taskLineageIds: ["task-1"],
			runtimeKinds: ["node"],
			runtimeVersions: ["22.0.0"],
			sourceRevisions: ["abc123"],
			harnessVersions: [rootVersion],
			applicabilityBoundaries: ["repository changes"],
		},
		lessonIds: ["lesson-1"],
		supportingEvidenceIds: ["evidence-1"],
		contradictingEvidenceIds: ["evidence-2"],
		supportingTraceIds: ["trace-1"],
		contradictingTraceIds: ["trace-2"],
		expectedBenefit: "Future changes are verified",
		acceptanceCriterion: "Focused verification is recorded",
		risk: "The guidance could be too broad",
		rollbackDescription: "Remove the guidance",
		curatorConfidence: 0.9,
		uncertainty: null,
		counterexamples: [],
		conflictingProposalIds: [],
		instructionRelationship: { classification: "novel", relevantEntries: [], strengthening: null },
		disposition: "actionable",
		target: { kind: "evolution-memory", expectedHarnessVersion: rootVersion },
		action: "ADD",
		exactDelta: {
			operation: "ADD",
			destination: { section: "Verification", anchor: null },
			content: "Run focused verification before considering a change complete.",
			intendedScope: ["repository changes"],
		},
		expectedBaseDigest: `sha256:${"c".repeat(64)}`,
	};
	return {
		proposal,
		supportingEvidence: [evidence("evidence-1", "Run the focused browser verification before declaring success.")],
		contradictingEvidence: [evidence("evidence-2", "The static checks passed without a browser run.")],
		score: null,
		validationDisposition: "rejected",
		exactAppliedDiff: null,
		rollbackTarget: null,
	};
}

function evidence(evidenceId: string, text: string): EvolutionProposalDetail["supportingEvidence"][number] {
	return {
		evidenceId,
		kind: "session_item",
		itemType: "message",
		order: { traceSequence: 1, timestamp: null, causalIdentifiers: [], ambiguity: [] },
		traceSources: [],
		payload: { message: { content: [{ type: "text", text }] } },
	};
}

function client(currentOverview: EvolutionOverview): {
	client: EvolutionMenuClient;
	emit: (event: EvolutionProgressEvent) => void;
	unsubscribed: ReturnType<typeof vi.fn>;
	startManual: ReturnType<typeof vi.fn>;
	cancelJob: ReturnType<typeof vi.fn>;
	overviewCall: ReturnType<typeof vi.fn>;
	listHarnessVersionInfo: ReturnType<typeof vi.fn>;
	listCurrentDirectoryHarnessVersionInfo: ReturnType<typeof vi.fn>;
	listJobs: ReturnType<typeof vi.fn>;
	jobDetailCall: ReturnType<typeof vi.fn>;
	proposalDetailCall: ReturnType<typeof vi.fn>;
	getEnabled: ReturnType<typeof vi.fn>;
	setEnabled: ReturnType<typeof vi.fn>;
} {
	let listener: ((event: EvolutionProgressEvent) => void) | undefined;
	let enabled = true;
	const unsubscribed = vi.fn();
	const startManual = vi.fn().mockResolvedValue({ status: "created", job: job() });
	const cancelJob = vi.fn().mockResolvedValue(undefined);
	const overviewCall = vi.fn().mockResolvedValue(currentOverview);
	const listHarnessVersionInfo = vi
		.fn()
		.mockResolvedValue([{ version: rootVersion, kind: "default", evolvedAt: null, evolvedIn: null }]);
	const listCurrentDirectoryHarnessVersionInfo = vi.fn().mockResolvedValue([]);
	const listJobs = vi.fn().mockResolvedValue([]);
	const jobDetailCall = vi.fn().mockRejectedValue(new Error("unused"));
	const proposalDetailCall = vi.fn().mockRejectedValue(new Error("unused"));
	const getEnabled = vi.fn(() => enabled);
	const setEnabled = vi.fn(async (next: boolean) => {
		enabled = next;
	});
	return {
		client: {
			getEnabled,
			setEnabled,
			subscribe: (next) => {
				listener = next;
				return unsubscribed;
			},
			overview: overviewCall,
			listHarnessVersionInfo,
			listCurrentDirectoryHarnessVersionInfo,
			listJobs,
			jobDetail: jobDetailCall,
			proposalDetail: proposalDetailCall,
			startManual,
			resumeNewest: vi.fn().mockRejectedValue(new Error("unused")),
			cancelJob,
			rollback: vi.fn().mockRejectedValue(new Error("unused")),
		},
		emit: (event) => listener?.(event),
		unsubscribed,
		startManual,
		cancelJob,
		overviewCall,
		listHarnessVersionInfo,
		listCurrentDirectoryHarnessVersionInfo,
		listJobs,
		jobDetailCall,
		proposalDetailCall,
		getEnabled,
		setEnabled,
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
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Evolution tokens: 1,100,001");
		expect(output).toContain("Evolution invocations: 6");
		expect(output).toContain("Last evolution: never");
		expect(output).toContain("Session harness: [current] Default Diffex Agent");
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
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

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

	it("cancels a resumable job by its durable job ID", async () => {
		const resumable = job({
			jobId: "job-resumable",
			outcome: "interrupted",
			reasonCode: "shutdown",
			terminalAt: "2026-08-20T00:02:00.000Z",
			resumable: true,
			cancellable: true,
		});
		const fixture = client(overview({ newestResumableJob: resumable }));
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Cancel"));

		for (let index = 0; index < 6; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(160).join("\n"))).toContain(formatEvolutionJobLabel(resumable)),
		);
		component.handleInput("\n");

		await vi.waitFor(() => expect(fixture.cancelJob).toHaveBeenCalledWith("job-resumable"));
		component.dispose();
	});

	it("persists the self-evolution toggle and disables every other action", async () => {
		const fixture = client(overview());
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Toggle [on]"));

		for (let index = 0; index < 7; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");

		expect(fixture.setEnabled).toHaveBeenCalledWith(false);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Toggle [off]"));
		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Toggle [off]");
		expect(output).toContain("Next automatic evolution: Disabled");
		for (const action of ["Refresh", "Evolve", "View", "Resume", "Browse", "Rollback", "Cancel"]) {
			expect(output).toContain(`${action} [unavailable]`);
		}
	});

	it("polls durable job state without rendering removed diagnostics", async () => {
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
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(job())),
		);
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall.mock.calls.length).toBeGreaterThanOrEqual(2));

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Finished: Today at 1:25 pm");
		for (const removedLabel of [
			"Result:",
			"Proposals:",
			"Reflector budget:",
			"Coverage:",
			"Recovery attempts:",
			"Last error:",
		]) {
			expect(output).not.toContain(removedLabel);
		}
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
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(job())),
		);
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall).toHaveBeenCalledWith("job-active"));

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Trigger: manual");
		expect(output).toContain("Stage: reflecting (active)");
		expect(output).toContain("Finished: never");
		expect(output).toContain("Evolution token: 12,345");
		expect(output).toContain("Last checkpoint: Today at 9:05 am");
		expect(output).toContain("Base harness: [current] Default Diffex Agent");
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
			"Result:",
			"Proposals:",
			"Reflector budget:",
			"Coverage:",
			"Recovery attempts:",
			"Last error:",
		]) {
			expect(output).not.toContain(removedLabel);
		}
	});

	it("renders a readable proposal outcome without internal mutation diagnostics", async () => {
		const detail = proposalDetail();
		const fixture = client(overview());
		fixture.listJobs.mockResolvedValue([job()]);
		fixture.jobDetailCall.mockResolvedValue(
			jobDetail({ proposalIds: [detail.proposal.proposalId], proposals: [detail.proposal] }),
		);
		fixture.proposalDetailCall.mockResolvedValue(detail);
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

		for (let index = 0; index < 4; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(job())),
		);
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionProposalLabel(detail.proposal)),
		);
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.proposalDetailCall).toHaveBeenCalledOnce());

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain(formatEvolutionProposalLabel(detail.proposal));
		expect(output).not.toContain(detail.proposal.proposalId);
		expect(output).toContain("Validation: rejected");
		expect(output).toContain("Outcome: Run focused verification before considering a change complete.");
		expect(output).toContain("Supporting evidence (1)");
		expect(output).toContain("Contradicting evidence (1)");
		expect(output).not.toContain("Supporting evidence: evidence-1");
		expect(output).not.toContain("Contradicting evidence: evidence-2");
		for (const removedLabel of [
			"Summary:",
			"Action:",
			"Structured delta:",
			"Evidence ranking:",
			"Applied diff:",
			"Rollback target:",
		]) {
			expect(output).not.toContain(removedLabel);
		}

		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(
				"1. Run the focused browser verification before declaring success.",
			),
		);
		component.handleInput("\u001b");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain("Contradicting evidence (1)"),
		);
		component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(
				"1. The static checks passed without a browser run.",
			),
		);
		component.dispose();
	});

	it("formats non-add proposal outcomes as readable text", () => {
		const detail = proposalDetail();
		if (detail.proposal.disposition !== "actionable") throw new Error("Expected an actionable proposal");
		expect(
			formatEvolutionProposalOutcome({
				...detail.proposal,
				action: "REMOVE",
				exactDelta: {
					operation: "REMOVE",
					memoryItemId: "memory-1",
					expectedContentDigest: `sha256:${"d".repeat(64)}`,
					reason: "it is obsolete",
				},
			}),
		).toBe("Remove the existing evolution-memory entry because it is obsolete");
		expect(
			formatEvolutionProposalOutcome({
				...detail.proposal,
				action: "REPLACE",
				exactDelta: {
					operation: "REPLACE",
					removal: {
						memoryItemId: "memory-1",
						expectedContentDigest: `sha256:${"d".repeat(64)}`,
						reason: "it is imprecise",
					},
					addition: {
						destination: { section: "Verification", anchor: null },
						content: "Use precise verification guidance.",
						intendedScope: ["repository changes"],
					},
				},
			}),
		).toBe("Use precise verification guidance.");
	});

	it("formats evolution timestamps for today and earlier dates", () => {
		const now = new Date(2026, 7, 20, 15, 0);
		expect(formatEvolutionTimestamp(new Date(2026, 7, 20, 9, 5).toISOString(), now)).toBe("Today at 9:05 am");
		expect(formatEvolutionTimestamp(new Date(2026, 6, 28, 21, 30).toISOString(), now)).toBe("7/28 at 9:30 pm");
		expect(
			formatEvolutionJobLabel(
				job({ trigger: "automatic", stage: "completed", createdAt: new Date(2026, 7, 20, 9, 5).toISOString() }),
				now,
			),
		).toBe("Today at 9:05 am - auto - completed");
	});

	it("limits semantic proposal and evidence labels by Unicode characters", () => {
		const detail = proposalDetail();
		expect(formatEvolutionProposalLabel(detail.proposal)).toBe(
			"Proposal Run focused verification before considering a chan",
		);
		const preview = formatEvolutionEvidencePreview(evidence("evidence-long", `${"🙂".repeat(100)} trailing content`));
		expect([...preview]).toHaveLength(100);
		expect(preview).toBe("🙂".repeat(100));
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

	it("confirms that cancellation removes the round and refreshes past its interruption event", async () => {
		const fixture = client(overview({ activeJob: job() }));
		const status = vi.fn();
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			status,
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Cancel"));

		for (let index = 0; index < 6; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(160).join("\n"))).toContain(
				"The evolution round will be removed. Its tokens and invocations will remain available.",
			),
		);
		expect(fixture.cancelJob).not.toHaveBeenCalled();

		const overviewCallsBeforeCancellation = fixture.overviewCall.mock.calls.length;
		let resolveInterruptedOverview: ((value: EvolutionOverview) => void) | undefined;
		const interruptedOverview = new Promise<EvolutionOverview>((resolve) => {
			resolveInterruptedOverview = resolve;
		});
		fixture.overviewCall.mockImplementationOnce(() => interruptedOverview).mockResolvedValue(overview());
		fixture.cancelJob.mockImplementation(async () => {
			fixture.emit({
				jobId: "job-active",
				emittedAt: "2026-08-20T00:02:00.000Z",
				type: "failed",
				stage: "reflecting",
			});
			await Promise.resolve();
		});

		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.cancelJob).toHaveBeenCalledWith("job-active"));
		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalledTimes(overviewCallsBeforeCancellation + 1));
		resolveInterruptedOverview?.(
			overview({
				newestResumableJob: job({
					outcome: "interrupted",
					reasonCode: "shutdown",
					terminalAt: "2026-08-20T00:02:00.000Z",
					resumable: true,
					cancellable: false,
				}),
			}),
		);

		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalledTimes(overviewCallsBeforeCancellation + 2));
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Resume [unavailable]"));
		expect(status).toHaveBeenCalledWith("Evolution round removed", false);
		component.dispose();
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
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Browse"));
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

	it("recovers from a failed loading refresh when another refresh is queued", async () => {
		const fixture = client(overview());
		let rejectInitialOverview: ((error: Error) => void) | undefined;
		fixture.overviewCall
			.mockImplementationOnce(
				() =>
					new Promise<EvolutionOverview>((_resolve, reject) => {
						rejectInitialOverview = reject;
					}),
			)
			.mockResolvedValue(overview());
		const status = vi.fn();
		const render = vi.fn();
		const component = new EvolutionMenuComponent(fixture.client, () => {}, status, render);
		expect(stripAnsi(component.render(160).join("\n"))).toContain("Loading durable evolution state...");

		fixture.emit({
			jobId: "job-active",
			emittedAt: "2026-08-20T00:02:00.000Z",
			type: "failed",
			stage: "reflecting",
		});
		component.handleInput("\u001b[B");
		component.handleInput("\n");
		expect(fixture.startManual).not.toHaveBeenCalled();
		rejectInitialOverview?.(new Error("temporary durable state read failure"));

		await vi.waitFor(() => expect(status).toHaveBeenCalledWith("temporary durable state read failure", true));
		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalledTimes(2));
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Browse"));
		expect(stripAnsi(component.render(160).join("\n"))).not.toContain("Loading durable evolution state...");
		expect(render).toHaveBeenCalled();
		component.dispose();
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
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Browse"));
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
