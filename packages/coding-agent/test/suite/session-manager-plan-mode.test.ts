import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanImplementationPrompt, type PlanArtifact } from "../../src/core/plan-mode.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

describe("plan-mode session context", () => {
	it("rejects malformed persisted plans and normalizes newly appended artifacts", async () => {
		const harness = await createHarness();
		try {
			const sessionPath = join(harness.tempDir, "malformed-plan.jsonl");
			const timestamp = new Date().toISOString();
			writeFileSync(
				sessionPath,
				`${[
					{
						type: "session",
						version: 3,
						id: "malformed-plan-session",
						timestamp,
						cwd: harness.tempDir,
					},
					{
						type: "collaboration_mode_change",
						id: "mode-entry",
						parentId: null,
						timestamp,
						mode: "plan",
					},
					{
						type: "plan",
						id: "malformed-entry",
						parentId: "mode-entry",
						timestamp,
						plan: { id: "malformed-plan", title: "Bad plan", markdown: 42 },
					},
					{
						type: "message",
						id: "child-entry",
						parentId: "malformed-entry",
						timestamp,
						message: { role: "user", content: "This child must not become a default-mode root.", timestamp: 1 },
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
			);

			expect(() => SessionManager.open(sessionPath)).toThrow("invalid persisted plan artifact");

			const session = SessionManager.inMemory();
			session.appendCollaborationModeChange("plan");
			session.appendPlan({ id: "valid-plan", title: "  Valid\n plan  ", markdown: "  1. Preserve this.  " });
			expect(session.buildSessionContext().pendingPlan).toEqual({
				id: "valid-plan",
				title: "Valid plan",
				markdown: "1. Preserve this.",
			});
			expect(() =>
				session.appendPlan({ id: "unsafe plan id", title: "Unsafe", markdown: "1. Reject this." }),
			).toThrow("Invalid plan artifact");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects an orphan bridge left by a syntactically malformed plan line", async () => {
		const harness = await createHarness();
		try {
			const sessionPath = join(harness.tempDir, "malformed-plan-orphan.jsonl");
			const timestamp = new Date().toISOString();
			const header = JSON.stringify({
				type: "session",
				version: 3,
				id: "malformed-plan-orphan-session",
				timestamp,
				cwd: harness.tempDir,
			});
			const mode = JSON.stringify({
				type: "collaboration_mode_change",
				id: "mode-entry",
				parentId: null,
				timestamp,
				mode: "plan",
			});
			const child = JSON.stringify({
				type: "message",
				id: "child-entry",
				parentId: "malformed-plan-entry",
				timestamp,
				message: { role: "user", content: "Do not restore this child in default mode.", timestamp: 1 },
			});
			writeFileSync(sessionPath, `${header}\n${mode}\n{"type":"plan","id":"malformed-plan-entry"\n${child}\n`);

			expect(() => SessionManager.open(sessionPath)).toThrow("malformed JSONL record at line 3");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a valid plan artifact persisted outside plan mode", async () => {
		const harness = await createHarness();
		try {
			const sessionPath = join(harness.tempDir, "plan-without-mode.jsonl");
			const timestamp = new Date().toISOString();
			writeFileSync(
				sessionPath,
				`${[
					{
						type: "session",
						version: 3,
						id: "plan-without-mode-session",
						timestamp,
						cwd: harness.tempDir,
					},
					{
						type: "plan",
						id: "plan-entry",
						parentId: null,
						timestamp,
						plan: { id: "valid-plan", title: "Valid plan", markdown: "1. Must not fail open." },
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
			);

			expect(() => SessionManager.open(sessionPath)).toThrow("outside plan mode");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects a persisted resolution that does not match the pending plan", async () => {
		const harness = await createHarness();
		try {
			const sessionPath = join(harness.tempDir, "mismatched-resolution.jsonl");
			const timestamp = new Date().toISOString();
			writeFileSync(
				sessionPath,
				`${[
					{
						type: "session",
						version: 3,
						id: "mismatched-resolution-session",
						timestamp,
						cwd: harness.tempDir,
					},
					{
						type: "collaboration_mode_change",
						id: "mode-entry",
						parentId: null,
						timestamp,
						mode: "plan",
					},
					{
						type: "plan",
						id: "plan-entry",
						parentId: "mode-entry",
						timestamp,
						plan: { id: "pending-plan", title: "Pending", markdown: "1. Remain pending." },
					},
					{
						type: "plan_resolution",
						id: "resolution-entry",
						parentId: "plan-entry",
						timestamp,
						planId: "different-plan",
						resolution: "implement",
					},
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`,
			);

			expect(() => SessionManager.open(sessionPath)).toThrow("does not match the pending plan");
		} finally {
			harness.cleanup();
		}
	});

	it("enforces plan lifecycle transitions through public append methods", () => {
		const session = SessionManager.inMemory();
		const plan: PlanArtifact = { id: "plan-lifecycle", title: "Lifecycle", markdown: "1. Enforce it." };

		expect(() => session.appendPlan(plan)).toThrow("only be appended in plan mode");
		session.appendCollaborationModeChange("plan");
		expect(() => session.appendPlanResolution(plan.id, "implement")).toThrow("does not match");
		session.appendPlan(plan);
		expect(() => session.appendCollaborationModeChange("default")).toThrow("Resolve the pending plan");
		expect(() => session.appendPlanResolution("another-plan", "implement")).toThrow("does not match");
		session.appendPlanResolution(plan.id, "implement");

		expect(session.buildSessionContext()).toMatchObject({
			collaborationMode: "default",
			pendingPlan: undefined,
			pendingPlanContinuation: plan,
		});
		expect(() => session.appendCollaborationModeChange("plan")).toThrow("pending plan continuation");
		session.appendPlanContinuationMessage({
			role: "user",
			content: [{ type: "text", text: createPlanImplementationPrompt(plan) }],
			timestamp: 1,
		});
		expect(session.buildSessionContext().pendingPlanContinuation).toBeUndefined();
	});

	it("restores pending plans from the active branch across compaction and resolution", () => {
		const session = SessionManager.inMemory();
		const plan: PlanArtifact = {
			id: "plan-1",
			title: "Persisted plan",
			markdown: "1. Preserve the artifact.",
		};
		const modeEntryId = session.appendCollaborationModeChange("plan");
		const planEntryId = session.appendPlan(plan);
		session.appendCompaction("Compacted planning context", modeEntryId, 100);

		expect(session.buildSessionContext()).toMatchObject({ collaborationMode: "plan", pendingPlan: plan });

		const resolutionEntryId = session.appendPlanResolution(plan.id, "implement");
		expect(session.buildSessionContext()).toMatchObject({
			collaborationMode: "default",
			pendingPlan: undefined,
			pendingPlanContinuation: plan,
		});
		session.appendPlanContinuationMessage({
			role: "user",
			content: [{ type: "text", text: createPlanImplementationPrompt(plan) }],
			timestamp: 1,
		});
		expect(session.buildSessionContext().pendingPlanContinuation).toBeUndefined();
		session.branch(resolutionEntryId);
		expect(session.buildSessionContext().pendingPlanContinuation).toEqual(plan);

		session.branch(planEntryId);
		expect(session.buildSessionContext()).toMatchObject({ collaborationMode: "plan", pendingPlan: plan });
	});

	it("derives default mode from a discarded plan resolution", () => {
		const session = SessionManager.inMemory();
		const plan: PlanArtifact = {
			id: "plan-discard-1",
			title: "Discarded plan",
			markdown: "1. Discard this plan.",
		};
		session.appendCollaborationModeChange("plan");
		session.appendPlan(plan);
		session.appendPlanResolution(plan.id, "discard");

		expect(session.buildSessionContext()).toMatchObject({ collaborationMode: "default", pendingPlan: undefined });
		expect(session.getEntries().filter((entry) => entry.type === "collaboration_mode_change")).toHaveLength(1);
	});
});
