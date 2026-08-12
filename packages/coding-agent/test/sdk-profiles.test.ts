import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTelemetryContext } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvolvedNote } from "../src/core/evolved.ts";
import { createHarnessDescriptor } from "../src/core/harness-descriptors.ts";
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
		expect(session.systemPrompt).toContain('<base_prompt type="DEFAULT" id="general">');

		session.dispose();
	});

	it("reports requested tools that the active profile denies instead of dropping them silently", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session, deniedToolsMessage } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: "finance",
			tools: ["read", "bash"],
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.agent.state.tools.map(({ name }) => name)).toEqual(["read"]);
		expect(deniedToolsMessage).toContain("bash");
		expect(deniedToolsMessage).toContain("finance");

		session.dispose();
	});

	it("keeps general-purpose tools available in the DEFAULT bootstrap", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const { session, deniedToolsMessage } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			tools: ["read", "bash"],
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.resourceLoader.getActiveProfile().id).toBe("general");
		expect(session.agent.state.tools.map(({ name }) => name).sort()).toEqual(["bash", "read"]);
		expect(deniedToolsMessage).toBeUndefined();

		session.dispose();
	});

	it("uses the selected profile for prompt, tools, metadata, and evolution", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(cwd);
		const telemetryContext = new InMemoryTelemetryContext();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: "general",
			sessionManager,
			telemetryContext,
		});

		expect(session.systemPrompt).toContain('<base_prompt type="DEFAULT" id="general">');
		expect(session.systemPrompt).toContain("Complete the user's task accurately, concisely, and transparently.");
		expect(session.agent.state.tools.map(({ name }) => name).sort()).toEqual([
			"bash",
			"edit",
			"evolve",
			"read",
			"write",
		]);
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
		const evolutionSpan = telemetryContext.getSpans().find((span) => span.name === "pi.harness.evolution");
		expect(evolutionSpan?.attributes).toMatchObject({
			"pi.session.id": session.sessionId,
			"pi.evolution.trigger": "explicit",
			"pi.evolution.profile_id": "general",
			"pi.evolution.outcome": "completed",
			"pi.evolution.candidate_count": 1,
			"pi.evolution.accepted_count": 1,
		});
		expect(JSON.stringify(evolutionSpan)).not.toContain("Prefer tables");
		expect(JSON.stringify(evolutionSpan)).not.toContain(evolvedPath);
		await expect(
			evolve!.execute("evolve-rejected", {
				note: "Forged marker <!-- pi:evolved-note-end -->",
				category: "preference",
				scope: "global",
			}),
		).rejects.toThrow("reserved EVOLVED.md control markers");
		const failedEvolution = telemetryContext
			.getSpans()
			.filter((span) => span.name === "pi.harness.evolution")
			.at(-1);
		expect(failedEvolution?.status.status).toBe("error");
		expect(failedEvolution?.attributes).toMatchObject({
			"pi.evolution.outcome": "failed",
			"pi.evolution.candidate_count": 1,
			"pi.evolution.accepted_count": 0,
			"pi.evolution.rejected_count": 1,
		});
		expect(JSON.stringify(failedEvolution)).not.toContain("Forged marker");

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
		expect(session.systemPrompt).toContain('<base_prompt type="PROMPT_PROFILE" id="finance">');
		expect(session.systemPrompt).toContain("Treat this as a high-stakes task.");

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
		expect(session.systemPrompt).toContain('<base_prompt type="DEFAULT" id="general">');

		session.dispose();
	});

	it("loads custom profiles as immutable and writes their evolution only to EVOLVED.md", async () => {
		const profileDir = join(agentDir, "profiles", "policy-analysis");
		const manifestPath = join(profileDir, "profile.json");
		const promptPath = join(profileDir, "PROMPT.md");
		mkdirSync(profileDir, { recursive: true });
		const prompt = "Analyze policy evidence without changing this immutable prompt.\n";
		const manifest = `${JSON.stringify(
			{
				schemaVersion: 1,
				id: "policy-analysis",
				name: "Policy Analysis",
				description: "Analyze policy evidence.",
				promptFile: "PROMPT.md",
				routing: {
					description: "Use for policy evidence analysis.",
					examples: ["Compare these policies"],
					keywords: ["policy"],
				},
				tools: { default: ["read"], required: [], denied: [] },
				guardrails: {
					highStakes: false,
					requireHumanReview: false,
					requireCurrentSources: true,
					disallowedActions: [],
					instructions: ["Separate evidence from inference."],
				},
				promptGuidelines: ["Cite primary sources."],
				compactionInstructions: "Preserve claims and sources.",
			},
			null,
			2,
		)}\n`;
		writeFileSync(promptPath, prompt);
		writeFileSync(manifestPath, manifest);
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: profileDir,
			sessionManager: SessionManager.inMemory(cwd),
		});

		const activeProfile = session.resourceLoader.getActiveProfile();
		expect(activeProfile).toMatchObject({ id: "policy-analysis", origin: "user", immutable: true });
		expect(session.systemPrompt).toContain('<base_prompt type="PROMPT_PROFILE" id="policy-analysis">');
		expect(session.systemPrompt).toContain(prompt.trim());
		const evolve = session.agent.state.tools.find(({ name }) => name === "evolve");
		expect(evolve).toBeTruthy();
		await evolve!.execute("evolve-custom", {
			note: "Preserve the policy source date.",
			category: "workflow",
			scope: "global",
		});

		expect(readFileSync(promptPath, "utf-8")).toBe(prompt);
		expect(readFileSync(manifestPath, "utf-8")).toBe(manifest);
		const evolved = readFileSync(join(agentDir, "EVOLVED.md"), "utf-8");
		expect(evolved).toContain("Profile: policy-analysis");
		expect(evolved).toContain("Preserve the policy source date.");
		session.dispose();
	});

	it("applies harness-scoped EVOLVED notes without copying them into profiles or descriptors", async () => {
		const descriptor = createHarnessDescriptor({
			agentDir,
			id: "evidence-review-a1b2c3",
			name: "Evidence review",
			description: "Review source evidence.",
			baseProfileId: "research",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		const descriptorBefore = readFileSync(descriptor.sourcePath, "utf-8");
		appendEvolvedNote({
			agentDir,
			scope: "global",
			profileId: descriptor.id,
			category: "workflow",
			provenance: "test",
			content: "HARNESS_ONLY_LESSON",
		});
		appendEvolvedNote({
			agentDir,
			scope: "global",
			profileId: "research",
			category: "workflow",
			provenance: "test",
			content: "BASE_PROFILE_ONLY_LESSON",
		});
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			profile: "research",
			profileRouting: "auto",
			harnessId: descriptor.id,
			sessionManager,
		});

		expect(session.resourceLoader.getActiveProfile()).toMatchObject({
			id: "research",
			origin: "builtin",
			immutable: true,
		});
		expect(sessionManager.getHeader()?.profile).toMatchObject({
			id: "research",
			harnessId: descriptor.id,
		});
		expect(session.systemPrompt).toContain("HARNESS_ONLY_LESSON");
		expect(session.systemPrompt).not.toContain("BASE_PROFILE_ONLY_LESSON");
		const evolve = session.agent.state.tools.find(({ name }) => name === "evolve");
		expect(evolve).toBeTruthy();
		await evolve!.execute("evolve-harness", {
			note: "NEW_HARNESS_LESSON",
			category: "workflow",
			scope: "global",
		});

		expect(readFileSync(descriptor.sourcePath, "utf-8")).toBe(descriptorBefore);
		expect(descriptorBefore).not.toContain("HARNESS_ONLY_LESSON");
		const evolved = readFileSync(join(agentDir, "EVOLVED.md"), "utf-8");
		expect(evolved).toContain(`Profile: ${descriptor.id}`);
		expect(evolved).toContain("NEW_HARNESS_LESSON");
		session.dispose();
	});
});
