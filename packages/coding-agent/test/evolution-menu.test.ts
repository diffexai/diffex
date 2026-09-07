import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import { setKeybindings } from "@earendil-works/diffex-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
	type EvolutionJobDetail,
	type EvolutionJobSummary,
	type EvolutionMemoryProposal,
	type EvolutionOverview,
	type EvolutionProposalDetail,
	type EvolutionSkillCandidateDetail,
} from "#evolution";
import type { EvolutionRuntimeEvent } from "../src/core/evolution-runtime.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type EvolutionMenuClient,
	EvolutionMenuComponent,
	evolutionSkillCandidateStageStatus,
	explainEvolutionCandidateReason,
	formatEvolutionEvidencePreview,
	formatEvolutionJobLabel,
	formatEvolutionJobResult,
	formatEvolutionProposalLabel,
	formatEvolutionProposalOutcome,
	formatEvolutionSkillCandidateOutcome,
	formatEvolutionSkillDraftDiff,
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
		analysisStatus: "processing",
		candidateGeneration: {
			status: "not-applicable",
			stage: null,
			updatedAt: null,
			attempt: 0,
			retryNotBefore: null,
			failureMessage: null,
		},
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
			evidenceTokens: 12_345,
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
		skillCandidates: overrides.skillCandidates ?? [],
		skillCandidateExpansionFailures: overrides.skillCandidateExpansionFailures ?? [],
	};
}

function overview(overrides: Partial<EvolutionOverview> = {}): EvolutionOverview {
	return {
		scope: { repositoryId: "repository", scopeId: "repository" },
		processedEvidenceCursor: 2,
		ingestionHighWaterCursor: 8,
		unprocessedTokens: 1_100_001,
		settledInvocationCount: 6,
		automaticTokenThreshold: AUTOMATIC_EVOLUTION_TOKEN_THRESHOLD,
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

function skillCandidateDetail(overrides: Partial<EvolutionSkillCandidateDetail> = {}): EvolutionSkillCandidateDetail {
	const detail = {
		summary: {
			candidateId: "candidate-1",
			groupId: "group-1",
			proposedName: "focused-verification",
			operation: "CREATE",
			state: "accepted",
			latestTransitionAt: "2026-08-20T00:00:02.000Z",
			latestReasonCodes: ["retrieval-and-behavior-gates-passed"],
		},
		candidate: {
			sourceLessonIds: ["lesson-1"],
			supportingEvidenceIds: ["evidence-1"],
			contradictingEvidenceIds: ["evidence-2"],
			supportingTraceIds: ["trace-1"],
			contradictingTraceIds: ["trace-2"],
			taskLineageIds: ["task-1"],
			trigger: {
				description: "A focused change needs outcome-based verification.",
				positiveExamples: [],
				negativeExamples: [],
			},
			procedure: {
				steps: [
					{ sequence: 1, action: "Run the focused check.", condition: null },
					{ sequence: 2, action: "Inspect the observed result.", condition: "the check fails" },
				],
				requiredTools: [],
				environment: [],
			},
		},
		supportingEvidence: [evidence("evidence-1", "The focused browser verification passed after the change.")],
		contradictingEvidence: [evidence("evidence-2", "A static check passed without exercising the changed path.")],
		sourceEvolutionJobIds: ["job-active"],
		proposalRevisionIds: ["revision-1"],
		existingContents: [],
		draft: {
			operation: "CREATE",
			content: "---\nname: focused-verification\ndescription: Verify focused changes.\n---\n\nRun checks.\n",
			files: [{ path: "scripts/check.sh", content: "#!/bin/sh\nexec npm run check\n" }],
		},
		validation: { disposition: "accepted", issues: [] },
		evaluation: {
			disposition: "accepted",
			gates: {
				suite: { passed: true, reasonCodes: [] },
				retrieval: { passed: true, reasonCodes: [] },
				behavior: { passed: true, reasonCodes: [] },
			},
			metrics: {
				exactRetrievalAccuracy: 1,
				heldOutIntendedImprovement: 0.5,
				negativeRegressionCount: 0,
				misapplicationCount: 0,
			},
		},
		targetHarnessVersion: null,
		rollbackTargetHarnessVersion: null,
		rollbackAvailable: false,
		activationAvailable: true,
		...overrides,
	} as unknown as EvolutionSkillCandidateDetail;
	return detail;
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
	emit: (event: EvolutionRuntimeEvent) => void;
	setExternalEnabled: (enabled: boolean) => void;
	unsubscribed: ReturnType<typeof vi.fn>;
	startManual: ReturnType<typeof vi.fn>;
	cancelJob: ReturnType<typeof vi.fn>;
	overviewCall: ReturnType<typeof vi.fn>;
	listHarnessVersionInfo: ReturnType<typeof vi.fn>;
	listCurrentDirectoryHarnessVersionInfo: ReturnType<typeof vi.fn>;
	listJobs: ReturnType<typeof vi.fn>;
	jobDetailCall: ReturnType<typeof vi.fn>;
	proposalDetailCall: ReturnType<typeof vi.fn>;
	skillCandidateDetailCall: ReturnType<typeof vi.fn>;
	activateSkillCandidate: ReturnType<typeof vi.fn>;
	rollbackSkillCandidate: ReturnType<typeof vi.fn>;
	getEnabled: ReturnType<typeof vi.fn>;
	setEnabled: ReturnType<typeof vi.fn>;
} {
	let listener: ((event: EvolutionRuntimeEvent) => void) | undefined;
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
	const skillCandidateDetailCall = vi.fn().mockRejectedValue(new Error("unused"));
	const activateSkillCandidate = vi.fn().mockResolvedValue({
		groupId: "group-1",
		batchId: "batch-1",
		targetHarnessVersion: `sha256:${"d".repeat(64)}`,
		receipt: {},
	});
	const rollbackSkillCandidate = vi.fn().mockResolvedValue({
		jobId: "job-active",
		fromHarnessVersion: `sha256:${"d".repeat(64)}`,
		toHarnessVersion: rootVersion,
		proposalIds: ["candidate-1"],
	});
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
			skillCandidateDetail: skillCandidateDetailCall,
			activateSkillCandidate,
			rollbackSkillCandidate,
			startManual,
			resumeNewest: vi.fn().mockRejectedValue(new Error("unused")),
			cancelJob,
			rollback: vi.fn().mockRejectedValue(new Error("unused")),
		},
		emit: (event) => listener?.(event),
		setExternalEnabled: (next) => {
			enabled = next;
		},
		unsubscribed,
		startManual,
		cancelJob,
		overviewCall,
		listHarnessVersionInfo,
		listCurrentDirectoryHarnessVersionInfo,
		listJobs,
		jobDetailCall,
		proposalDetailCall,
		skillCandidateDetailCall,
		activateSkillCandidate,
		rollbackSkillCandidate,
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
		expect(output).not.toContain("View");
		expect(output).toContain("Resume [unavailable]");
		expect(output).toContain("Browse");
		expect(output).not.toContain("Rollback");
		expect(output).toContain("Cancel");

		component.handleInput("\u001b[B");
		component.handleInput("\n");
		expect(fixture.startManual).not.toHaveBeenCalled();
		component.handleInput("\u001b[B");
		component.handleInput("\n");
		expect(fixture.jobDetailCall).not.toHaveBeenCalled();
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
		expect(output).not.toContain("View");
		expect(output).toContain("Resume [unavailable]");
		expect(output).toContain("Browse");
		expect(output).not.toContain("Rollback");
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

		for (let index = 0; index < 4; index += 1) component.handleInput("\u001b[B");
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

		for (let index = 0; index < 6; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");

		expect(fixture.setEnabled).toHaveBeenCalledWith(false);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Toggle [off]"));
		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Toggle [off]");
		expect(output).toContain("Next automatic evolution: Disabled");
		for (const action of ["Refresh", "Evolve", "Resume", "Browse", "Cancel"]) {
			expect(output).toContain(`${action} [unavailable]`);
		}
	});

	it("displays and selects the evolution model", async () => {
		const fixture = client(overview());
		const selectModel = vi.fn();
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
			1_000,
			{
				getModel: () => ({ provider: "faux", model: "faux-evolution" }),
				selectModel,
			},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Model [faux-evolution]"));

		for (let index = 0; index < 5; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");

		expect(selectModel).toHaveBeenCalledOnce();
		component.dispose();
	});

	it("rebuilds an idle menu when another process disables evolution", async () => {
		const fixture = client(overview());
		const render = vi.fn();
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			render,
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Toggle [on]"));

		component.handleInput("\u001b[B");
		fixture.setExternalEnabled(false);
		fixture.emit({ type: "enabled-changed", enabled: false });

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Toggle [off]");
		expect(output).toContain("Next automatic evolution: Disabled");
		for (const action of ["Refresh", "Evolve", "Resume", "Browse", "Cancel"]) {
			expect(output).toContain(`${action} [unavailable]`);
		}
		expect(render).toHaveBeenCalled();
		component.handleInput("\n");
		expect(fixture.startManual).not.toHaveBeenCalled();
		component.dispose();
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
			analysisStatus: "failed",
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

		for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(job())),
		);
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall.mock.calls.length).toBeGreaterThanOrEqual(2));

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Result: analysis failed");
		expect(output).toContain("Analysis: failed");
		for (const removedLabel of [
			"Analysis finished:",
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

	it("shows lesson grooming only in Browse without creating a job and clears it immediately", async () => {
		const fixture = client(overview());
		const render = vi.fn();
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			render,
		);
		try {
			await component.refresh();
			fixture.emit({ type: "lesson-grooming", active: true });
			expect(stripAnsi(component.render(160).join("\n"))).not.toContain("Reorganizing lessons");

			for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
			component.handleInput("\n");
			await component.refresh();
			const output = stripAnsi(component.render(160).join("\n"));
			expect(output).toContain("Reorganizing lessons");
			expect(output).toContain("No evolution jobs");
			expect(fixture.startManual).not.toHaveBeenCalled();

			render.mockClear();
			fixture.emit({ type: "lesson-grooming", active: false });
			expect(stripAnsi(component.render(160).join("\n"))).not.toContain("Reorganizing lessons");
			expect(render).toHaveBeenCalled();
			await component.refresh();
			expect(stripAnsi(component.render(160).join("\n"))).not.toContain("Reorganizing lessons");

			fixture.emit({ type: "lesson-grooming", active: true });
			expect(stripAnsi(component.render(160).join("\n"))).toContain("Reorganizing lessons");
			await component.refresh();
			component.dispose();
			render.mockClear();
			fixture.emit({ type: "lesson-grooming", active: false });
			expect(render).not.toHaveBeenCalled();
		} finally {
			component.dispose();
		}
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

		for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(job())),
		);
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall).toHaveBeenCalledWith("job-active"));

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Trigger: manual");
		expect(output).toContain("Result: analysis reflecting");
		expect(output).toContain("Analysis: reflecting");
		expect(output).toContain("Evolution token: 12,345");
		expect(output).toContain("Last checkpoint: Today at 9:05 am");
		expect(output).toContain("Base harness: [current] Default Diffex Agent");
		for (const removedLabel of [
			"Candidate generation:",
			"Candidate updated:",
			"Analysis finished:",
			"Target harness:",
			"Rollback available:",
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
			"Next prompt will refresh:",
			"Proposals:",
			"Reflector budget:",
			"Coverage:",
			"Recovery attempts:",
			"Last error:",
		]) {
			expect(output).not.toContain(removedLabel);
		}
	});

	it("shows terminal asynchronous candidate failure after analysis completed", async () => {
		const candidateGeneration = {
			status: "partial-failure" as const,
			stage: "synthesizing" as const,
			updatedAt: "2026-08-20T12:35:00.000Z",
			attempt: 3,
			retryNotBefore: null,
			failureMessage: "Skill synthesis failed for candidate group group-1",
		};
		const summary = job({
			stage: "completed",
			outcome: "completed",
			analysisStatus: "completed",
			candidateGeneration,
			terminalAt: "2026-08-20T12:34:00.000Z",
		});
		const fixture = client(overview());
		fixture.listJobs.mockResolvedValue([summary]);
		const successfulCandidate = skillCandidateDetail().summary;
		fixture.jobDetailCall.mockResolvedValue(
			jobDetail({
				...summary,
				candidateGeneration,
				skillCandidates: [successfulCandidate],
				skillCandidateExpansionFailures: [
					{
						outlineId: "outline-1",
						outlineKey: "verification-recovery",
						proposedName: "verification-recovery",
						operation: "CREATE",
						diagnostic: {
							reasonCode: "procedure-draft-invalid",
							message: "Procedure generation failed after two attempts.",
							attempts: [
								{
									attempt: 1,
									modelRounds: 1,
									reasonCode: "procedure-draft-invalid",
									message: "The procedure draft did not satisfy the required contract.",
									inspectedReferences: { evidenceIds: ["evidence-1"], skillIds: [] },
									invalidFieldPaths: ["completionCondition"],
								},
								{
									attempt: 2,
									modelRounds: 1,
									reasonCode: "procedure-draft-invalid",
									message: "The procedure draft did not satisfy the required contract.",
									inspectedReferences: { evidenceIds: ["evidence-1"], skillIds: [] },
									invalidFieldPaths: ["verificationChecks"],
								},
							],
						},
					},
				],
			}),
		);
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

		for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(summary)),
		);
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall).toHaveBeenCalledWith("job-active"));

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Result: partial failure");
		expect(output).toContain("Analysis: completed");
		expect(output).not.toContain("Candidate generation:");
		expect(output).toContain("Candidate error: Skill synthesis failed for candidate group group-1");
		expect(output).toContain(`Skill ${successfulCandidate.proposedName} - accepted`);
		expect(output).toContain(
			"Skill verification-recovery - Procedure generation failed after two attempts. [failed]",
		);
		component.dispose();
	});

	it("continues polling candidate work after the analysis job completes", async () => {
		const waitingGeneration = {
			status: "waiting" as const,
			stage: null,
			updatedAt: null,
			attempt: 0,
			retryNotBefore: null,
			failureMessage: null,
		};
		const completedGeneration = {
			status: "completed" as const,
			stage: "completed" as const,
			updatedAt: "2026-08-20T12:35:00.000Z",
			attempt: 1,
			retryNotBefore: null,
			failureMessage: null,
		};
		const summary = job({
			stage: "completed",
			outcome: "completed",
			analysisStatus: "completed",
			candidateGeneration: waitingGeneration,
			terminalAt: "2026-08-20T12:34:00.000Z",
		});
		const fixture = client(overview());
		fixture.listJobs.mockResolvedValue([summary]);
		fixture.jobDetailCall
			.mockResolvedValueOnce(jobDetail({ ...summary, candidateGeneration: waitingGeneration }))
			.mockResolvedValue(jobDetail({ ...summary, candidateGeneration: completedGeneration }));
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
			5,
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

		for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(summary)),
		);
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.jobDetailCall.mock.calls.length).toBeGreaterThanOrEqual(2));
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Result: full success"));
		expect(stripAnsi(component.render(180).join("\n"))).not.toContain("Candidate generation:");
		component.dispose();
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

		for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
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

	it("reviews candidate provenance, draft, validation, and evaluation without manual activation", async () => {
		const detail = skillCandidateDetail();
		const fixture = client(overview());
		fixture.listJobs.mockResolvedValue([job()]);
		fixture.jobDetailCall.mockResolvedValue(
			jobDetail({
				skillCandidates: [detail.summary],
			}),
		);
		fixture.skillCandidateDetailCall.mockResolvedValue(detail);
		const status = vi.fn();
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			status,
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

		for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(job())),
		);
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain("Skill focused-verification - accepted"),
		);
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(fixture.skillCandidateDetailCall).toHaveBeenCalledWith("job-active", "candidate-1"),
		);

		let output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("Skill candidate focused-verification");
		expect(output).toContain("State: accepted");
		expect(output).toContain("State changed:");
		expect(output).toContain("Reason: Retrieval and behavior evaluation passed.");
		expect(output).toContain("Use when: A focused change needs outcome-based verification.");
		expect(output).toContain("Outcome: Run the focused check. Inspect the observed result. (the check fails)");
		expect(output).not.toContain("Reason code:");
		expect(output).not.toContain("Target harness:");
		expect(output).not.toContain("Operation:");
		expect(output).not.toContain("Rollback available:");
		expect(output).not.toContain("Provenance");
		expect(output).not.toContain("job-active");
		expect(output).not.toContain("evidence-1");
		expect(output).toContain("Supporting evidence (1)");
		expect(output).toContain("Contradicting evidence (1)");
		expect(output).toContain("Draft diff [completed]");
		expect(output).toContain("Validation [completed]");
		expect(output).toContain("Evaluation [completed]");
		expect(output).not.toContain("Activate");
		expect(output).not.toContain("Rollback [unavailable]");

		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(
				"1. The focused browser verification passed after the change.",
			),
		);
		component.handleInput("\u001b");
		component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(
				"1. A static check passed without exercising the changed path.",
			),
		);
		component.handleInput("\u001b");
		for (let index = 0; index < 2; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("+Run checks."));
		component.handleInput("\u001b");
		for (let index = 0; index < 4; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain("Retrieval and behavior evaluation"),
		);
		output = stripAnsi(component.render(180).join("\n"));
		expect(output).toContain("retrieval: passed");
		expect(output).toContain("Negative regressions: 0");

		expect(fixture.activateSkillCandidate).not.toHaveBeenCalled();
		expect(status).not.toHaveBeenCalled();
		component.dispose();
	});

	it("omits skipped skill evaluation and unavailable actions", async () => {
		const baseDetail = skillCandidateDetail();
		const detail = skillCandidateDetail({
			evaluation: null,
			summary: {
				...baseDetail.summary,
				latestReasonCodes: ["retrieval-and-behavior-evaluation-skipped"],
			},
		});
		const fixture = client(overview());
		fixture.listJobs.mockResolvedValue([job()]);
		fixture.jobDetailCall.mockResolvedValue(jobDetail({ skillCandidates: [detail.summary] }));
		fixture.skillCandidateDetailCall.mockResolvedValue(detail);
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(180).join("\n"))).toContain("Browse"));

		for (let index = 0; index < 3; index += 1) component.handleInput("\u001b[B");
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain(formatEvolutionJobLabel(job())),
		);
		component.handleInput("\n");
		await vi.waitFor(() =>
			expect(stripAnsi(component.render(180).join("\n"))).toContain("Skill focused-verification - accepted"),
		);
		component.handleInput("\n");
		await vi.waitFor(() => expect(fixture.skillCandidateDetailCall).toHaveBeenCalledOnce());

		const output = stripAnsi(component.render(180).join("\n"));
		expect(output).not.toContain("Evaluation [skipped]");
		expect(output).not.toContain("Activate");
		expect(output).not.toContain("Rollback [unavailable]");
		component.dispose();
	});

	it("distinguishes blocked, failed, skipped, completed, and inapplicable candidate stages", () => {
		const base = skillCandidateDetail();
		const detailWithState = (
			state: EvolutionSkillCandidateDetail["summary"]["state"],
			overrides: Partial<EvolutionSkillCandidateDetail> = {},
		) =>
			skillCandidateDetail({
				...overrides,
				summary: { ...base.summary, state, ...(overrides.summary ?? {}) },
			});
		const proposed = detailWithState("proposed", { draft: null, validation: null, evaluation: null });
		expect([
			evolutionSkillCandidateStageStatus(proposed, "draft"),
			evolutionSkillCandidateStageStatus(proposed, "validation"),
			evolutionSkillCandidateStageStatus(proposed, "evaluation"),
		]).toEqual(["blocked", "blocked", "blocked"]);

		const synthesisFailed = detailWithState("synthesis-failed", {
			draft: null,
			validation: null,
			evaluation: null,
		});
		expect([
			evolutionSkillCandidateStageStatus(synthesisFailed, "draft"),
			evolutionSkillCandidateStageStatus(synthesisFailed, "validation"),
			evolutionSkillCandidateStageStatus(synthesisFailed, "evaluation"),
		]).toEqual(["failed", "skipped", "not applicable"]);

		const rejected = detailWithState("rejected", {
			validation: { ...base.validation, disposition: "rejected" } as EvolutionSkillCandidateDetail["validation"],
			evaluation: null,
		});
		expect([
			evolutionSkillCandidateStageStatus(rejected, "draft"),
			evolutionSkillCandidateStageStatus(rejected, "validation"),
			evolutionSkillCandidateStageStatus(rejected, "evaluation"),
		]).toEqual(["completed", "failed", "not applicable"]);

		const quarantined = detailWithState("quarantined", {
			evaluation: { ...base.evaluation, disposition: "quarantined" } as EvolutionSkillCandidateDetail["evaluation"],
		});
		expect([
			evolutionSkillCandidateStageStatus(quarantined, "draft"),
			evolutionSkillCandidateStageStatus(quarantined, "validation"),
			evolutionSkillCandidateStageStatus(quarantined, "evaluation"),
		]).toEqual(["completed", "completed", "failed"]);

		const skipped = detailWithState("accepted", {
			evaluation: null,
			summary: { ...base.summary, latestReasonCodes: ["retrieval-and-behavior-evaluation-skipped"] },
		});
		expect([
			evolutionSkillCandidateStageStatus(skipped, "draft"),
			evolutionSkillCandidateStageStatus(skipped, "validation"),
			evolutionSkillCandidateStageStatus(skipped, "evaluation"),
		]).toEqual(["completed", "completed", "skipped"]);

		expect(explainEvolutionCandidateReason("counterevidence-meets-or-exceeds-support")).toBe(
			"Counterevidence matches or exceeds the supporting evidence.",
		);
		expect(explainEvolutionCandidateReason("custom-raw-code")).toBe("custom raw code.");
	});

	it("formats a readable candidate outcome and create, update, and retirement draft diffs", () => {
		expect(formatEvolutionSkillCandidateOutcome(skillCandidateDetail())).toBe(
			"Run the focused check. Inspect the observed result. (the check fails)",
		);
		const createDiff = formatEvolutionSkillDraftDiff(skillCandidateDetail());
		expect(createDiff).toContain("+Run checks.");
		expect(createDiff).toContain("+# Supporting file: scripts/check.sh");
		expect(createDiff).toContain("+exec npm run check");
		const existingContents = [{ skillId: "skill-1", name: "old", version: "v1", content: "old line\n" }];
		expect(
			formatEvolutionSkillDraftDiff(
				skillCandidateDetail({
					existingContents,
					draft: { ...skillCandidateDetail().draft, operation: "UPDATE", content: "new line\n" },
				} as unknown as Partial<EvolutionSkillCandidateDetail>),
			),
		).toEqual(expect.arrayContaining(["-old line", "+new line"]));
		expect(
			formatEvolutionSkillDraftDiff(
				skillCandidateDetail({
					existingContents,
					draft: { ...skillCandidateDetail().draft, operation: "RETIRE" },
				} as unknown as Partial<EvolutionSkillCandidateDetail>),
			),
		).toContain("-old line");
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
						content: "Use precise verification guidance.",
						intendedScope: ["repository changes"],
					},
				},
			}),
		).toBe("Use precise verification guidance.");
	});

	it("displays each active analysis stage", () => {
		const stages = [
			["snapshotting", "analysis snapshotting"],
			["counter-slot", "analysis reserving counter slot"],
			["reflecting", "analysis reflecting"],
			["curating", "analysis curating EVOLVE.md"],
			["validating", "analysis validating proposals"],
			["skill-curating", "analysis curating skills"],
			["writing", "analysis writing EVOLVE.md"],
			["activating", "analysis activating harness"],
		] as const;
		for (const [stage, expected] of stages) {
			expect(formatEvolutionJobResult(job({ stage }))).toBe(expected);
		}
	});

	it("formats evolution timestamps for today and earlier dates", () => {
		const now = new Date(2026, 7, 20, 15, 0);
		expect(formatEvolutionTimestamp(new Date(2026, 7, 20, 9, 5).toISOString(), now)).toBe("Today at 9:05 am");
		expect(formatEvolutionTimestamp(new Date(2026, 6, 28, 21, 30).toISOString(), now)).toBe("7/28 at 9:30 pm");
		expect(
			formatEvolutionJobLabel(
				job({
					trigger: "automatic",
					stage: "completed",
					analysisStatus: "completed",
					candidateGeneration: {
						status: "completed",
						stage: "completed",
						updatedAt: new Date(2026, 7, 20, 9, 6).toISOString(),
						attempt: 1,
						retryNotBefore: null,
						failureMessage: null,
					},
					createdAt: new Date(2026, 7, 20, 9, 5).toISOString(),
				}),
				now,
			),
		).toBe("Today at 9:05 am - auto - full success");
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

		for (let index = 0; index < 4; index += 1) component.handleInput("\u001b[B");
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
		const cancellingOutput = stripAnsi(component.render(160).join("\n"));
		expect(cancellingOutput).toContain(
			"The evolution round will be removed. Its tokens and invocations will remain available.",
		);
		expect(cancellingOutput).not.toContain("Loading durable evolution state...");
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

	it("preserves the current view while refreshing an active job", async () => {
		const activeOverview = overview({ activeJob: job() });
		const fixture = client(activeOverview);
		let resolveRefreshedOverview: ((value: EvolutionOverview) => void) | undefined;
		fixture.overviewCall.mockResolvedValueOnce(activeOverview).mockImplementationOnce(
			() =>
				new Promise<EvolutionOverview>((resolve) => {
					resolveRefreshedOverview = resolve;
				}),
		);
		const component = new EvolutionMenuComponent(
			fixture.client,
			() => {},
			() => {},
			() => {},
			60_000,
		);
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Evolution tokens:"));

		fixture.emit({
			jobId: "job-active",
			emittedAt: "2026-08-20T00:02:00.000Z",
			type: "checkpoint",
			stage: "reflecting",
		});
		await vi.waitFor(() => expect(fixture.overviewCall).toHaveBeenCalledTimes(2));

		const refreshingOutput = stripAnsi(component.render(160).join("\n"));
		expect(refreshingOutput).toContain("Evolution tokens: 1,100,001");
		expect(refreshingOutput).not.toContain("Loading durable evolution state...");

		resolveRefreshedOverview?.(activeOverview);
		await vi.waitFor(() => expect(stripAnsi(component.render(160).join("\n"))).toContain("Browse"));
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
