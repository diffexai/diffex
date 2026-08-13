import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/diffex-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvolvedNote, createGeneratedProfile, finalizeGeneratedProfile } from "../src/core/evolved.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("createAgentSession task profiles", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses a neutral bootstrap with automatic-routing metadata by default", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(sessionManager.getHeader()?.profile).toMatchObject({ id: "general", routing: "auto" });
		expect(session.systemPrompt).toContain('<task_profile id="general">');

		session.dispose();
	});

	it("reports requested tools that the active profile denies instead of dropping them silently", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session, deniedToolsMessage } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			tools: ["read", "bash"],
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.agent.state.tools.map(({ name }) => name)).toEqual(["read"]);
		expect(deniedToolsMessage).toContain("bash");
		expect(deniedToolsMessage).toContain("general");

		session.dispose();
	});

	it("does not report denied tools when the allowlist is satisfiable", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session, deniedToolsMessage } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			tools: ["read"],
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(deniedToolsMessage).toBeUndefined();

		session.dispose();
	});

	it("uses the selected profile for prompt, tools, metadata, and evolution", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: "general",
			sessionManager,
		});

		expect(session.systemPrompt).toContain('<task_profile id="general">');
		expect(session.systemPrompt).toContain("task-agnostic assistant");
		expect(session.agent.state.tools.map(({ name }) => name).sort()).toEqual(["edit", "evolve", "read", "write"]);
		expect(sessionManager.getHeader()?.profile).toMatchObject({ id: "general", routing: "pinned" });

		const evolvedPath = join(agentDir, "EVOLVED.md");
		expect(readFileSync(evolvedPath, "utf-8")).toBe("");
		const evolve = session.agent.state.tools.find(({ name }) => name === "evolve");
		expect(evolve).toBeTruthy();
		await evolve!.execute("evolve-1", {
			note: "Prefer tables when comparing three or more alternatives.",
			category: "preference",
			scope: "global",
		});
		const evolved = readFileSync(evolvedPath, "utf-8");
		expect(evolved).toContain("### preference");
		expect(evolved).toContain("Prefer tables when comparing three or more alternatives.");
		expect(evolved).toContain("Profile: general");

		session.dispose();
	});

	it("enforces profile-denied tools after an explicit allowlist", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: "finance",
			tools: ["read", "bash"],
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.agent.state.tools.map(({ name }) => name)).toEqual(["read"]);
		expect(session.systemPrompt).toContain('<profile_guardrails profile="finance" high_stakes="true">');

		session.dispose();
	});

	it("injects only evolution notes relevant to the active profile", async () => {
		appendEvolvedNote({
			agentDir,
			scope: "global",
			profileId: "general",
			category: "workflow",
			provenance: "test",
			content: "GENERAL_ONLY_LESSON",
		});
		appendEvolvedNote({
			agentDir,
			scope: "global",
			profileId: "finance",
			category: "workflow",
			provenance: "test",
			content: "FINANCE_ONLY_LESSON",
		});
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: "finance",
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.systemPrompt).toContain("FINANCE_ONLY_LESSON");
		expect(session.systemPrompt).not.toContain("GENERAL_ONLY_LESSON");

		session.dispose();
	});

	it("marks auto selection as routable and starts from general", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: "auto",
			sessionManager,
		});

		expect(sessionManager.getHeader()?.profile).toMatchObject({ id: "general", routing: "auto" });
		expect(session.systemPrompt).toContain('<task_profile id="general">');

		session.dispose();
	});

	it("does not repeat evolved notes already merged into a generated profile prompt", async () => {
		const olderNoteText = "Prefer   SOURCE CITATIONS before consequential claims.";
		const newerNoteText = "prefer source citations before consequential claims.";
		const generated = createGeneratedProfile({
			agentDir,
			label: "Generated analysis",
			description: "Analyze a specialized task.",
		});
		const olderNote = appendEvolvedNote({
			agentDir,
			scope: "global",
			profileId: generated.id,
			category: "workflow",
			provenance: "test",
			content: olderNoteText,
			timestamp: "2026-01-01T00:00:00.000Z",
		});
		const newerNote = appendEvolvedNote({
			agentDir,
			scope: "global",
			profileId: generated.id,
			category: "workflow",
			provenance: "test",
			content: newerNoteText,
			timestamp: "2026-01-02T00:00:00.000Z",
		});
		expect(olderNote.hash).not.toBe(newerNote.hash);
		const finalized = finalizeGeneratedProfile({
			agentDir,
			profile: generated,
			notes: [olderNote, newerNote],
		});
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: finalized.source.path,
			sessionManager: SessionManager.inMemory(cwd),
		});

		const normalizedPrompt = session.systemPrompt
			.normalize("NFKC")
			.replace(/\s+/g, " ")
			.trim()
			.toLocaleLowerCase("en-US");
		const normalizedLesson = newerNoteText.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
		expect(normalizedPrompt.split(normalizedLesson)).toHaveLength(2);
		session.dispose();
	});
});
