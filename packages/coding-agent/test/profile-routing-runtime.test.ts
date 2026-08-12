import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	buildRecentTaskContext,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ProfileSwitchEvent,
	resolveProfileRoutingMode,
	resolvePromptForProfileRouting,
	TaskBoundaryCancelledError,
	type TaskBoundaryProposal,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { appendEvolvedNote } from "../src/core/evolved.ts";
import { createHarnessDescriptor, loadHarnessDescriptors } from "../src/core/harness-descriptors.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResolvedTaskProfile } from "../src/core/profiles.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { BoundedTelemetryCapture, readEvolutionTraceSnapshot } from "../src/core/telemetry-capture.ts";

function selectDecision(
	profileId: string,
	harnessName = "Focused task",
	harnessDescription = "Complete the user's focused task.",
): string {
	return JSON.stringify({
		decision: "select",
		profileId,
		confidence: 0.99,
		reason: `The ${profileId} base profile best fits the requested outcome.`,
		harnessName,
		harnessDescription,
	});
}

function reuseDecision(harnessId: string, profileId: string): string {
	return JSON.stringify({
		decision: "reuse",
		harnessId,
		profileId,
		confidence: 0.99,
		reason: "The evolved harness clearly fits the requested outcome.",
	});
}

describe("AgentSessionRuntime profile routing", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createRuntimeHost(
		profileRouting: "auto" | "pinned" = "auto",
		profile = "coding",
		options?: { persist?: boolean },
	) {
		const tempDir = join(tmpdir(), `pi-profile-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		const telemetryCapture = new BoundedTelemetryCapture();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});

		const runtimeRequests: Array<{
			profile?: string;
			profileRouting?: "auto" | "pinned";
			harnessId?: string;
		}> = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
			profile: nextProfile,
			profileRouting: nextRouting,
			harnessId,
			telemetryContext,
			telemetryCapture: nextTelemetryCapture,
		}) => {
			runtimeRequests.push({ profile: nextProfile, profileRouting: nextRouting, harnessId });
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				modelRuntime,
				telemetryContext,
				telemetryCapture: nextTelemetryCapture,
				resourceLoaderOptions: {
					profile: nextProfile,
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
					profileRouting: nextRouting,
					harnessId,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager:
				options?.persist === false
					? SessionManager.inMemory(tempDir)
					: SessionManager.create(tempDir, join(tempDir, "sessions")),
			profile,
			profileRouting,
			telemetryCapture,
		});
		await runtimeHost.session.bindExtensions({});
		runtimeHost.setRebindSession(async (session) => session.bindExtensions({}));
		let disposed = false;
		const dispose = async () => {
			if (disposed) return;
			disposed = true;
			await runtimeHost.dispose();
		};

		cleanups.push(() => {
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		cleanups.push(dispose);
		return { runtimeHost, faux, tempDir, runtimeRequests, telemetryCapture, createRuntime };
	}

	it("answers the first accepted task with DEFAULT, then creates a descriptor for a built-in profile", async () => {
		const { runtimeHost, faux, tempDir, runtimeRequests } = await createRuntimeHost();
		let firstSystemPrompt = "";
		faux.setResponses([
			(context) => {
				firstSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("default answer");
			},
			fauxAssistantMessage(selectDecision("finance", "Portfolio comparison", "Compare investment risk.")),
		]);

		const initialSessionFile = runtimeHost.session.sessionFile;
		const result = await runtimeHost.prompt("Compare the cash-flow risk in these investments.");

		expect(firstSystemPrompt).toContain('base_prompt type="DEFAULT" id="general"');
		expect(result).toMatchObject({
			routing: "selected",
			activeProfileId: "finance",
			previousProfileId: "general",
		});
		expect(runtimeHost.activeProfile.id).toBe("finance");
		expect(runtimeHost.session.sessionFile).toBe(initialSessionFile);
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("default answer");
		expect(runtimeHost.session.sessionManager.getHeader()?.profile).toMatchObject({
			id: "finance",
			routing: "auto",
			harnessId: result.harnessId,
			harnessRevision: result.harnessRevision,
		});
		expect(runtimeRequests).toMatchObject([
			{ profile: "general", profileRouting: "auto" },
			{ profile: "finance", profileRouting: "auto", harnessId: result.harnessId },
		]);
		const descriptorPath = join(tempDir, "harnesses", `${result.harnessId}.json`);
		const descriptor = readFileSync(descriptorPath, "utf-8");
		expect(descriptor).toContain('"baseProfileId": "finance"');
		expect(descriptor).not.toContain("prompt");
		expect(faux.state.callCount).toBe(2);
	});

	it("uses the active session model instead of silently selecting a cheaper sibling", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		const sessionModel = runtimeHost.session.model;
		if (!sessionModel) throw new Error("Expected an active session model");
		const cheapRouterModelId = "cheap-router";
		runtimeHost.session.modelRuntime.registerProvider(sessionModel.provider, {
			baseUrl: sessionModel.baseUrl,
			api: sessionModel.api,
			models: [
				{
					id: sessionModel.id,
					name: sessionModel.name,
					reasoning: sessionModel.reasoning,
					input: sessionModel.input,
					cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
					contextWindow: sessionModel.contextWindow,
					maxTokens: sessionModel.maxTokens,
				},
				{
					id: cheapRouterModelId,
					name: "Cheap Router",
					reasoning: false,
					input: ["text"],
					cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				},
			],
		});
		const routedWith: string[] = [];
		faux.setResponses([
			fauxAssistantMessage("default answer"),
			(_context, _options, _state, model) => {
				routedWith.push(model.id);
				return fauxAssistantMessage(selectDecision("finance"));
			},
		]);

		await runtimeHost.prompt("Compare these investments.");

		expect(routedWith).toEqual([sessionModel.id]);
	});

	it("offers only immutable built-in profiles to automatic routing", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		const loadedProfiles = runtimeHost.services.resourceLoader.getProfiles();
		const coding = loadedProfiles.profiles.find((profile) => profile.id === "coding");
		if (!coding) throw new Error("Expected built-in coding profile");
		const customProfile: ResolvedTaskProfile = {
			...coding,
			id: "custom-policy",
			name: "Custom Policy",
			description: "User-authored policy workflow.",
			origin: "user",
			immutable: true,
			hash: "custom-policy-hash",
			source: { path: join(tempDir, "profiles", "custom-policy", "profile.json"), label: "test" },
		};
		vi.spyOn(runtimeHost.services.resourceLoader, "getProfiles").mockReturnValue({
			...loadedProfiles,
			profiles: [...loadedProfiles.profiles, customProfile],
		});
		let routerRequest = "";
		faux.setResponses([
			fauxAssistantMessage("default answer"),
			(context) => {
				routerRequest = JSON.stringify(context);
				return fauxAssistantMessage(selectDecision("research", "Evidence task", "Review source evidence."));
			},
		]);

		const result = await runtimeHost.prompt("Review the primary source evidence.");

		expect(result).toMatchObject({ routing: "selected", activeProfileId: "research" });
		expect(routerRequest).not.toContain("custom-policy");
		expect(routerRequest).not.toContain("Custom Policy");
	});

	it("resolves only once and does not reroute later turns", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage(selectDecision("coding", "Parser repair", "Repair and verify the parser.")),
			fauxAssistantMessage("second answer"),
		]);

		await runtimeHost.prompt("Fix the parser bug.");
		const second = await runtimeHost.prompt("Now add the regression test.");

		expect(second).toMatchObject({ routing: "bypassed", activeProfileId: "coding" });
		expect(second.harnessId).toBe(runtimeHost.activeHarness?.id);
		expect(faux.state.callCount).toBe(3);
	});

	it("does not classify explicit steer or follow-up deliveries as task boundaries", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		const resolver = vi.fn(async () => "switch" as const);
		runtimeHost.setTaskBoundaryResolver(resolver);
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Mortgage analysis", "Compare mortgage options.")),
			fauxAssistantMessage("queued-style answer"),
		]);

		await runtimeHost.prompt("Compare paying down my mortgage with investing.");
		const result = await runtimeHost.prompt("Fix this TypeScript parser instead.", {
			streamingBehavior: "followUp",
		});

		expect(result).toMatchObject({ routing: "bypassed", activeProfileId: "finance" });
		expect(resolver).not.toHaveBeenCalled();
		expect(faux.state.callCount).toBe(3);
	});

	it("confirms a finance-to-coding boundary before delivering the prompt once in an independent session", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		const proposals: TaskBoundaryProposal[] = [];
		runtimeHost.setTaskBoundaryResolver(async (proposal) => {
			proposals.push(proposal);
			return "switch";
		});
		const shiftedPrompt = "Now, as a separate task, fix this TypeScript parser bug.";
		let shiftedTaskSystemPrompt = "";
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Mortgage analysis", "Compare mortgage options.")),
			fauxAssistantMessage(selectDecision("coding", "Parser repair", "Repair and verify a parser.")),
			(context) => {
				shiftedTaskSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("parser fixed");
			},
		]);

		await runtimeHost.prompt("Compare paying down my mortgage with investing.");
		const previousSessionFile = runtimeHost.session.sessionFile;
		const previousSessionId = runtimeHost.session.sessionManager.getSessionId();
		const previousHarnessId = runtimeHost.activeHarness?.id;
		if (!previousHarnessId) throw new Error("Expected the Finance harness");
		const result = await runtimeHost.prompt(shiftedPrompt);

		expect(proposals).toEqual([
			expect.objectContaining({
				decision: "select",
				fromProfileId: "finance",
				toProfileId: "coding",
				targetHarnessName: "Parser repair",
			}),
		]);
		expect(result).toMatchObject({
			routing: "selected",
			activeProfileId: "coding",
			previousProfileId: "finance",
		});
		expect(runtimeHost.session.sessionFile).not.toBe(previousSessionFile);
		expect(runtimeHost.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		expect(runtimeHost.session.sessionManager.getRelatedSessions()).toContainEqual({
			sessionId: previousSessionId,
			harnessId: previousHarnessId,
		});
		expect(
			runtimeHost.session.messages.filter((message) => JSON.stringify(message).includes(shiftedPrompt)),
		).toHaveLength(1);
		expect(shiftedTaskSystemPrompt).toContain('base_prompt type="PROMPT_PROFILE" id="coding"');
		expect(faux.state.callCount).toBe(4);
	});

	it("returns from coding to an existing unevolved finance harness", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		const proposals: TaskBoundaryProposal[] = [];
		runtimeHost.setTaskBoundaryResolver(async (proposal) => {
			proposals.push(proposal);
			return "switch";
		});
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(
				selectDecision(
					"finance",
					"Roth IRA investment guidance",
					"Compare Roth IRA investments and contribution decisions.",
				),
			),
		]);

		const finance = await runtimeHost.prompt("I want to buy some stocks with my Roth IRA. What should I buy?");
		if (!finance.harnessId) throw new Error("Expected the initial Finance harness");
		const financeSessionFile = runtimeHost.session.sessionFile;
		const financeSessionId = runtimeHost.session.sessionManager.getSessionId();
		if (!financeSessionFile) throw new Error("Expected the Finance session to persist");
		expect(
			loadHarnessDescriptors({ agentDir: tempDir }).harnesses.find((harness) => harness.id === finance.harnessId)
				?.harnessNoteCount,
		).toBe(0);

		faux.setResponses([
			fauxAssistantMessage(
				selectDecision("coding", "Basic chatbot implementation", "Design and implement a basic chatbot."),
			),
			fauxAssistantMessage("coding answer"),
		]);
		await runtimeHost.prompt("Actually, help me implement a basic chatbot instead.");
		const codingSessionId = runtimeHost.session.sessionManager.getSessionId();
		const codingHarnessId = runtimeHost.activeHarness?.id;
		if (!codingHarnessId) throw new Error("Expected the Coding harness");
		expect(runtimeHost.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		expect(runtimeHost.session.sessionManager.getRelatedSessions()).toContainEqual({
			sessionId: financeSessionId,
			harnessId: finance.harnessId,
		});
		expect(SessionManager.open(financeSessionFile).getRelatedSessions()).toContainEqual({
			sessionId: codingSessionId,
			harnessId: codingHarnessId,
		});

		faux.setResponses([
			fauxAssistantMessage(reuseDecision(finance.harnessId, "finance")),
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain("I want to buy some stocks with my Roth IRA");
				expect(messages).toContain("financial answer");
				expect(messages).not.toContain("coding answer");
				return fauxAssistantMessage("continued Roth IRA answer");
			},
		]);
		const returned = await runtimeHost.prompt("Let's go back to our Roth IRA discussion. I just got a paycheck.");

		expect(proposals.at(-1)).toMatchObject({
			decision: "reuse",
			targetHarnessId: finance.harnessId,
			targetHarnessName: "Roth IRA investment guidance",
			willResumeSession: true,
		});
		expect(returned).toMatchObject({
			routing: "reused",
			activeProfileId: "finance",
			harnessId: finance.harnessId,
		});
		expect(runtimeHost.session.sessionFile).toBe(financeSessionFile);
		expect(runtimeHost.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		expect(runtimeHost.session.sessionManager.getRelatedSessions()).toContainEqual({
			sessionId: codingSessionId,
			harnessId: codingHarnessId,
		});
		const sessions = await SessionManager.list(tempDir, join(tempDir, "sessions"));
		expect(sessions).toHaveLength(2);
		expect(sessions.every((session) => session.parentSessionPath === undefined)).toBe(true);
		expect(loadHarnessDescriptors({ agentDir: tempDir }).harnesses).toHaveLength(2);
		expect(faux.state.callCount).toBe(6);
	});

	it("restores cross-session references after restart and resumes the earlier harness transcript", async () => {
		const { runtimeHost, faux, tempDir, createRuntime } = await createRuntimeHost();
		runtimeHost.setTaskBoundaryResolver(async () => "switch");
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Retirement investing", "Compare retirement investments.")),
		]);
		const finance = await runtimeHost.prompt("Compare investments for my Roth IRA.");
		if (!finance.harnessId) throw new Error("Expected the Finance harness");
		const financeSessionFile = runtimeHost.session.sessionFile;
		if (!financeSessionFile) throw new Error("Expected the Finance session file");

		faux.setResponses([
			fauxAssistantMessage(
				selectDecision("coding", "Chatbot implementation", "Implement a customer support chatbot."),
			),
			fauxAssistantMessage("coding answer"),
		]);
		await runtimeHost.prompt("Switching tasks: implement a customer support chatbot.");
		const codingSessionFile = runtimeHost.session.sessionFile;
		if (!codingSessionFile) throw new Error("Expected the Coding session file");

		const resumedRuntime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.open(codingSessionFile),
		});
		await resumedRuntime.session.bindExtensions({});
		resumedRuntime.setRebindSession(async (session) => session.bindExtensions({}));
		resumedRuntime.setTaskBoundaryResolver(async (proposal) => {
			expect(proposal).toMatchObject({
				decision: "reuse",
				targetHarnessId: finance.harnessId,
				willResumeSession: true,
			});
			return "switch";
		});
		faux.setResponses([
			fauxAssistantMessage(reuseDecision(finance.harnessId, "finance")),
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain("Compare investments for my Roth IRA");
				expect(messages).not.toContain("coding answer");
				return fauxAssistantMessage("resumed finance answer");
			},
		]);

		const result = await resumedRuntime.prompt("Go back to the Roth IRA task.");

		expect(result).toMatchObject({ routing: "reused", harnessId: finance.harnessId });
		expect(resumedRuntime.session.sessionFile).toBe(financeSessionFile);
		expect(await SessionManager.list(tempDir, join(tempDir, "sessions"))).toHaveLength(2);
		await resumedRuntime.dispose();
	});

	it("returns to a prior in-memory harness transcript without creating ancestry", async () => {
		const { runtimeHost, faux } = await createRuntimeHost("auto", "coding", { persist: false });
		runtimeHost.setTaskBoundaryResolver(async () => "switch");
		faux.setResponses([
			fauxAssistantMessage("in-memory financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Roth planning", "Plan Roth IRA investments.")),
		]);

		const finance = await runtimeHost.prompt("Plan investments for my Roth IRA.");
		if (!finance.harnessId) throw new Error("Expected the Finance harness");
		faux.setResponses([
			fauxAssistantMessage(selectDecision("coding", "Chatbot build", "Build a chatbot.")),
			fauxAssistantMessage("in-memory coding answer"),
		]);
		await runtimeHost.prompt("New task: build a chatbot.");
		faux.setResponses([
			fauxAssistantMessage(reuseDecision(finance.harnessId, "finance")),
			(context) => {
				const messages = JSON.stringify(context.messages);
				expect(messages).toContain("Plan investments for my Roth IRA");
				expect(messages).not.toContain("in-memory coding answer");
				return fauxAssistantMessage("resumed in-memory answer");
			},
		]);

		const result = await runtimeHost.prompt("Return to the Roth IRA planning task.");

		expect(result).toMatchObject({ routing: "reused", harnessId: finance.harnessId });
		expect(runtimeHost.session.sessionFile).toBeUndefined();
		expect(runtimeHost.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
	});

	it("rejects a stale related session after confirmation without delivering the held prompt", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		let financeSessionFile: string | undefined;
		runtimeHost.setTaskBoundaryResolver(async (proposal) => {
			if (proposal.decision === "reuse") {
				expect(proposal.willResumeSession).toBe(true);
				if (!financeSessionFile) throw new Error("Expected the Finance session file");
				rmSync(financeSessionFile);
			}
			return "switch";
		});
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Roth planning", "Plan Roth IRA investments.")),
		]);
		const finance = await runtimeHost.prompt("Plan investments for my Roth IRA.");
		if (!finance.harnessId) throw new Error("Expected the Finance harness");
		financeSessionFile = runtimeHost.session.sessionFile;

		faux.setResponses([
			fauxAssistantMessage(selectDecision("coding", "Chatbot build", "Build a chatbot.")),
			fauxAssistantMessage("coding answer"),
		]);
		await runtimeHost.prompt("New task: build a chatbot.");
		const codingSessionFile = runtimeHost.session.sessionFile;
		const returnPrompt = "Return to the Roth IRA planning task.";
		faux.setResponses([fauxAssistantMessage(reuseDecision(finance.harnessId, "finance"))]);

		await expect(runtimeHost.prompt(returnPrompt)).rejects.toThrow(
			`The previous session for harness "${finance.harnessId}" changed before it could be resumed`,
		);
		expect(runtimeHost.session.sessionFile).toBe(codingSessionFile);
		expect(runtimeHost.activeProfile.id).toBe("coding");
		expect(runtimeHost.session.messages.some((message) => JSON.stringify(message).includes(returnPrompt))).toBe(
			false,
		);
	});

	it("delivers a declined task boundary once under the current harness", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		const shiftedPrompt = "Now, as a separate task, fix this TypeScript parser bug.";
		runtimeHost.setTaskBoundaryResolver(async () => "stay");
		let deliveredSystemPrompt = "";
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Mortgage analysis", "Compare mortgage options.")),
			fauxAssistantMessage(selectDecision("coding", "Parser repair", "Repair and verify a parser.")),
			(context) => {
				deliveredSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("answered without switching");
			},
		]);

		await runtimeHost.prompt("Compare paying down my mortgage with investing.");
		const currentSessionFile = runtimeHost.session.sessionFile;
		const currentHarnessId = runtimeHost.activeHarness?.id;
		const result = await runtimeHost.prompt(shiftedPrompt);

		expect(result).toMatchObject({
			routing: "bypassed",
			activeProfileId: "finance",
			harnessId: currentHarnessId,
		});
		expect(runtimeHost.session.sessionFile).toBe(currentSessionFile);
		expect(
			runtimeHost.session.messages.filter((message) => JSON.stringify(message).includes(shiftedPrompt)),
		).toHaveLength(1);
		expect(deliveredSystemPrompt).toContain('base_prompt type="PROMPT_PROFILE" id="finance"');
		expect(faux.state.callCount).toBe(4);
	});

	it("reuses an evolved harness after confirmation and delivers the task once", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		const codingHarness = createHarnessDescriptor({
			agentDir: tempDir,
			id: "parser-repair-a1b2c3",
			name: "Parser repair",
			description: "Repair and verify TypeScript parsers.",
			baseProfileId: "coding",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		appendEvolvedNote({
			agentDir: tempDir,
			profileId: codingHarness.id,
			category: "verification",
			provenance: "test",
			content: "Always run the parser regression test.",
			scope: "global",
		});
		await runtimeHost.services.resourceLoader.reload();
		const proposals: TaskBoundaryProposal[] = [];
		runtimeHost.setTaskBoundaryResolver(async (proposal) => {
			proposals.push(proposal);
			return "switch";
		});
		const shiftedPrompt = "Switching to a separate task: repair the TypeScript parser.";
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Mortgage analysis", "Compare mortgage options.")),
			fauxAssistantMessage(reuseDecision(codingHarness.id, "coding")),
			fauxAssistantMessage("parser repaired"),
		]);

		await runtimeHost.prompt("Compare paying down my mortgage with investing.");
		const result = await runtimeHost.prompt(shiftedPrompt);

		expect(proposals[0]).toMatchObject({
			decision: "reuse",
			targetHarnessId: codingHarness.id,
			targetHarnessName: codingHarness.name,
			willResumeSession: false,
		});
		expect(result).toMatchObject({ routing: "reused", activeProfileId: "coding", harnessId: codingHarness.id });
		expect(
			runtimeHost.session.messages.filter((message) => JSON.stringify(message).includes(shiftedPrompt)),
		).toHaveLength(1);
		expect(runtimeHost.session.agent.state.systemPrompt).toContain("Always run the parser regression test.");
		expect(loadHarnessDescriptors({ agentDir: tempDir }).harnesses).toHaveLength(2);
		expect(faux.state.callCount).toBe(4);
	});

	it("rejects an evolved harness whose revision changes during confirmation", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		const codingHarness = createHarnessDescriptor({
			agentDir: tempDir,
			id: "parser-repair-stale-a1b2c3",
			name: "Parser repair",
			description: "Repair and verify TypeScript parsers.",
			baseProfileId: "coding",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		appendEvolvedNote({
			agentDir: tempDir,
			profileId: codingHarness.id,
			category: "verification",
			provenance: "test",
			content: "Run the parser regression test.",
			scope: "global",
		});
		await runtimeHost.services.resourceLoader.reload();
		runtimeHost.setTaskBoundaryResolver(async () => {
			appendEvolvedNote({
				agentDir: tempDir,
				profileId: codingHarness.id,
				category: "new constraint",
				provenance: "test",
				content: "Also run the integration test.",
				scope: "global",
			});
			return "switch";
		});
		const shiftedPrompt = "Switching to a separate task: repair the TypeScript parser.";
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Mortgage analysis", "Compare mortgage options.")),
			fauxAssistantMessage(reuseDecision(codingHarness.id, "coding")),
		]);

		await runtimeHost.prompt("Compare paying down my mortgage with investing.");
		const currentSessionFile = runtimeHost.session.sessionFile;

		await expect(runtimeHost.prompt(shiftedPrompt)).rejects.toThrow(
			"The selected harness changed while confirmation was pending",
		);
		expect(runtimeHost.session.sessionFile).toBe(currentSessionFile);
		expect(runtimeHost.activeProfile.id).toBe("finance");
		expect(runtimeHost.session.messages.some((message) => JSON.stringify(message).includes(shiftedPrompt))).toBe(
			false,
		);
		expect(faux.state.callCount).toBe(3);
	});

	it("revalidates a reusable harness after session switch hooks", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		const codingHarness = createHarnessDescriptor({
			agentDir: tempDir,
			id: "parser-repair-hook-a1b2c3",
			name: "Parser repair",
			description: "Repair and verify TypeScript parsers.",
			baseProfileId: "coding",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		appendEvolvedNote({
			agentDir: tempDir,
			profileId: codingHarness.id,
			category: "verification",
			provenance: "test",
			content: "Run the parser regression test.",
			scope: "global",
		});
		await runtimeHost.services.resourceLoader.reload();
		runtimeHost.setTaskBoundaryResolver(async () => "switch");
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Mortgage analysis", "Compare mortgage options.")),
		]);

		await runtimeHost.prompt("Compare paying down my mortgage with investing.");
		const currentSessionFile = runtimeHost.session.sessionFile;
		const extensionRunner = runtimeHost.session.extensionRunner;
		vi.spyOn(extensionRunner, "hasHandlers").mockImplementation((eventType) => eventType === "session_before_switch");
		vi.spyOn(extensionRunner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_switch") {
				appendEvolvedNote({
					agentDir: tempDir,
					profileId: codingHarness.id,
					category: "new constraint",
					provenance: "test hook",
					content: "Also run the integration test.",
					scope: "global",
				});
			}
			return undefined;
		});
		const shiftedPrompt = "Switching to a separate task: repair the TypeScript parser.";
		faux.setResponses([fauxAssistantMessage(reuseDecision(codingHarness.id, "coding"))]);

		await expect(runtimeHost.prompt(shiftedPrompt)).rejects.toThrow(
			"The selected harness changed while the session switch was pending",
		);
		expect(runtimeHost.session.sessionFile).toBe(currentSessionFile);
		expect(runtimeHost.activeProfile.id).toBe("finance");
		expect(runtimeHost.session.messages.some((message) => JSON.stringify(message).includes(shiftedPrompt))).toBe(
			false,
		);
		expect(faux.state.callCount).toBe(3);
	});

	it("reports the harness metadata restored during session replacement", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		const codingHarness = createHarnessDescriptor({
			agentDir: tempDir,
			id: "parser-repair-restored-a1b2c3",
			name: "Parser repair",
			description: "Repair and verify TypeScript parsers.",
			baseProfileId: "coding",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		appendEvolvedNote({
			agentDir: tempDir,
			profileId: codingHarness.id,
			category: "verification",
			provenance: "test",
			content: "Run the parser regression test.",
			scope: "global",
		});
		await runtimeHost.services.resourceLoader.reload();
		runtimeHost.setTaskBoundaryResolver(async () => "switch");
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Mortgage analysis", "Compare mortgage options.")),
		]);

		await runtimeHost.prompt("Compare paying down my mortgage with investing.");
		const switches: ProfileSwitchEvent[] = [];
		runtimeHost.setProfileSwitchListener((event) => switches.push(event));
		const outgoingSession = runtimeHost.session;
		const abort = outgoingSession.abort.bind(outgoingSession);
		vi.spyOn(outgoingSession, "abort").mockImplementation(async () => {
			await abort();
			const descriptorPath = join(tempDir, "harnesses", `${codingHarness.id}.json`);
			const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8")) as Record<string, unknown>;
			writeFileSync(
				descriptorPath,
				`${JSON.stringify({ ...descriptor, name: "Restored parser repair" }, null, 2)}\n`,
			);
		});
		faux.setResponses([
			fauxAssistantMessage(reuseDecision(codingHarness.id, "coding")),
			fauxAssistantMessage("parser repaired"),
		]);

		const result = await runtimeHost.prompt("Switching tasks: repair the TypeScript parser.");
		const activeHarness = runtimeHost.activeHarness;
		if (!activeHarness) throw new Error("Expected the restored Coding harness");

		expect(activeHarness.name).toBe("Restored parser repair");
		expect(result.harnessRevision).toBe(activeHarness.revision);
		expect(result.notice).toContain(`"${activeHarness.name}"`);
		expect(result.notice).toContain(activeHarness.revision.slice(0, 12));
		expect(switches.at(-1)).toMatchObject({
			harnessId: activeHarness.id,
			harnessRevision: activeHarness.revision,
			harnessName: activeHarness.name,
			notice: result.notice,
		});
	});

	it("cancels a proposed task boundary without delivering the prompt", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		const shiftedPrompt = "Now, as a separate task, fix this TypeScript parser bug.";
		runtimeHost.setTaskBoundaryResolver(async () => "cancel");
		faux.setResponses([
			fauxAssistantMessage("financial answer"),
			fauxAssistantMessage(selectDecision("finance", "Mortgage analysis", "Compare mortgage options.")),
			fauxAssistantMessage(selectDecision("coding", "Parser repair", "Repair and verify a parser.")),
		]);

		await runtimeHost.prompt("Compare paying down my mortgage with investing.");
		const currentSessionFile = runtimeHost.session.sessionFile;
		const preflightResult = vi.fn();

		await expect(runtimeHost.prompt(shiftedPrompt, { preflightResult })).rejects.toBeInstanceOf(
			TaskBoundaryCancelledError,
		);
		expect(preflightResult).toHaveBeenCalledOnce();
		expect(preflightResult).toHaveBeenCalledWith(false);
		expect(runtimeHost.session.sessionFile).toBe(currentSessionFile);
		expect(runtimeHost.session.messages.some((message) => JSON.stringify(message).includes(shiftedPrompt))).toBe(
			false,
		);
		expect(faux.state.callCount).toBe(3);
	});

	it("records the one-time route in native content-free telemetry", async () => {
		const { runtimeHost, faux, telemetryCapture } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage("default answer"),
			fauxAssistantMessage(selectDecision("research", "Evidence task", "Review source evidence.")),
		]);

		const result = await runtimeHost.prompt("Review the primary evidence.");
		const trace = readEvolutionTraceSnapshot(telemetryCapture);

		expect(trace.routes).toEqual([
			{
				trigger: "initial_turn",
				outcome: "selected",
				targetProfileId: "research",
				harnessId: result.harnessId,
			},
		]);
		expect(trace.aiRequestCount).toBeGreaterThanOrEqual(2);
	});

	it("holds a new task turn while post-turn routing activates its harness", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		let releaseRoute: (() => void) | undefined;
		const routeGate = new Promise<void>((resolveGate) => {
			releaseRoute = resolveGate;
		});
		faux.setResponses([
			fauxAssistantMessage("default answer"),
			async () => {
				await routeGate;
				return fauxAssistantMessage(selectDecision("research", "Evidence task", "Review source evidence."));
			},
			fauxAssistantMessage("research continuation"),
		]);

		const first = runtimeHost.prompt("Review evidence on this question.");
		await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
		expect(runtimeHost.session.isStreaming).toBe(false);
		let secondSettled = false;
		const second = runtimeHost.prompt("Continue with the primary sources.").finally(() => {
			secondSettled = true;
		});
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		expect(secondSettled).toBe(false);
		expect(faux.state.callCount).toBe(2);

		releaseRoute?.();
		await first;
		const result = await second;

		expect(result).toMatchObject({ routing: "bypassed", activeProfileId: "research" });
		expect(faux.state.callCount).toBe(3);
	});

	it("falls back to a general descriptor and stops routing when no match is available", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage("default answer"),
			fauxAssistantMessage("not valid router output"),
			fauxAssistantMessage("continued answer"),
		]);

		const first = await runtimeHost.prompt("Help me with an unusual task that has no profile.");
		const second = await runtimeHost.prompt("Continue.");

		expect(first).toMatchObject({ routing: "selected", activeProfileId: "general" });
		expect(second.routing).toBe("bypassed");
		expect(runtimeHost.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid-output"))).toBe(true);
		expect(loadHarnessDescriptors({ agentDir: tempDir }).harnesses).toHaveLength(1);
		expect(existsSync(join(tempDir, "profiles", "generated"))).toBe(false);
		expect(faux.state.callCount).toBe(3);
	});

	it("does not persist a General harness for an unambiguous finance task when the router fails", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage("default financial comparison"),
			fauxAssistantMessage("not valid router output"),
		]);

		const result = await runtimeHost.prompt(
			"i'm considering paying down a 6.5% mortgage with investing $10k in an index fund. what are some risks? would this be a wise financial move?",
		);

		expect(result).toMatchObject({
			routing: "selected",
			activeProfileId: "finance",
		});
		expect(runtimeHost.activeProfile.id).toBe("finance");
		expect(runtimeHost.diagnostics.some((diagnostic) => diagnostic.message.includes("invalid-output"))).toBe(true);
		const harness = loadHarnessDescriptors({ agentDir: tempDir }).harnesses[0];
		expect(harness?.baseProfileId).toBe("finance");
	});

	it("reuses the latest evolved harness and emits an interface-independent notice", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		const harness = createHarnessDescriptor({
			agentDir: tempDir,
			id: "evidence-review-a1b2c3",
			name: "Evidence review",
			description: "Review literature and compare evidence across sources.",
			baseProfileId: "research",
			createdAt: "2026-08-01T00:00:00.000Z",
		});
		appendEvolvedNote({
			agentDir: tempDir,
			profileId: harness.id,
			category: "source quality",
			provenance: "test",
			content: "Prefer primary research over derivative summaries.",
			scope: "global",
		});
		await runtimeHost.services.resourceLoader.reload();
		const switches: ProfileSwitchEvent[] = [];
		runtimeHost.setProfileSwitchListener((event) => switches.push(event));
		faux.setResponses([
			fauxAssistantMessage("default answer"),
			fauxAssistantMessage(reuseDecision(harness.id, "research")),
		]);

		const result = await runtimeHost.prompt("Review the literature and compare the evidence.");
		const resolved = loadHarnessDescriptors({
			agentDir: tempDir,
			notes: runtimeHost.services.resourceLoader.getEvolvedNotes().evolvedNotes,
		}).harnesses[0];

		expect(result).toMatchObject({
			routing: "reused",
			harnessId: harness.id,
			harnessRevision: resolved?.revision,
		});
		expect(result.notice).toBe(
			`Found evolved harness "Evidence review" for this task. Switched to revision ${resolved?.revision.slice(0, 12)}.`,
		);
		expect(switches[0]).toMatchObject({ harnessId: harness.id, reused: true, notice: result.notice });
		expect(runtimeHost.session.agent.state.systemPrompt).toContain(
			"Prefer primary research over derivative summaries.",
		);
	});

	it("restores a session's harness identity and revision without rerouting", async () => {
		const { runtimeHost, faux, runtimeRequests } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage(selectDecision("legal", "Contract review", "Review a contract clause.")),
		]);
		const first = await runtimeHost.prompt("Review this contract clause.");
		const sessionFile = runtimeHost.session.sessionFile;
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const finance = runtimeHost.services.resourceLoader
			.getProfiles()
			.profiles.find((profile) => profile.id === "finance");
		if (!finance || !first.harnessId || !first.harnessRevision) {
			throw new Error("Expected finance profile and persisted harness metadata");
		}
		runtimeHost.session.sessionManager.setProfileMetadata({
			id: finance.id,
			hash: finance.hash,
			routing: "auto",
			harnessId: first.harnessId,
			harnessRevision: first.harnessRevision,
		});

		await runtimeHost.switchSession(sessionFile);
		faux.setResponses([fauxAssistantMessage("resumed answer")]);
		const resumed = await runtimeHost.prompt("Continue the review.");

		expect(resumed).toMatchObject({
			routing: "bypassed",
			harnessId: first.harnessId,
			harnessRevision: first.harnessRevision,
		});
		expect(runtimeRequests.at(-1)).toMatchObject({
			profile: "legal",
			harnessId: first.harnessId,
		});
		expect(runtimeHost.session.sessionManager.getHeader()?.profile?.id).toBe("legal");
		expect(faux.state.callCount).toBe(3);
	});

	it("rejects a tampered custom-profile harness and resumes on DEFAULT", async () => {
		const { runtimeHost, faux, runtimeRequests, tempDir, createRuntime } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage(selectDecision("coding", "Parser repair", "Repair a parser.")),
		]);
		const first = await runtimeHost.prompt("Repair this parser.");
		const sessionFile = runtimeHost.session.sessionFile;
		if (!sessionFile || !first.harnessId) throw new Error("Expected persisted harness session");
		const descriptorPath = join(tempDir, "harnesses", `${first.harnessId}.json`);
		const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8")) as Record<string, unknown>;
		writeFileSync(descriptorPath, `${JSON.stringify({ ...descriptor, baseProfileId: "custom-policy" }, null, 2)}\n`);

		const resumedRuntime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.open(sessionFile),
		});
		cleanups.push(() => resumedRuntime.dispose());

		expect(runtimeRequests.at(-1)).toMatchObject({ profile: "general", profileRouting: "auto" });
		expect(runtimeRequests.at(-1)?.harnessId).toBeUndefined();
		expect(resumedRuntime.activeProfile.id).toBe("general");
		expect(resumedRuntime.activeHarness).toBeUndefined();
		expect(resumedRuntime.session.sessionManager.getHeader()?.profile).toMatchObject({
			id: "general",
			routing: "auto",
		});
		expect(resumedRuntime.session.sessionManager.getHeader()?.profile?.harnessId).toBeUndefined();
		expect(
			resumedRuntime.diagnostics.some((diagnostic) => diagnostic.message.includes("immutable built-in profile")),
		).toBe(true);
	});

	it("bypasses routing while a profile is explicitly pinned", async () => {
		const { runtimeHost, faux } = await createRuntimeHost("pinned", "coding");
		faux.setResponses([fauxAssistantMessage("done")]);

		const result = await runtimeHost.prompt("Review this balance sheet.");

		expect(result).toEqual({ routing: "bypassed", activeProfileId: "coding" });
		expect(faux.state.callCount).toBe(1);
	});

	it("keeps queued follow-up delivery while resolving after the completed first run", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		let releaseFirstResponse: (() => void) | undefined;
		const firstResponseGate = new Promise<void>((resolveGate) => {
			releaseFirstResponse = resolveGate;
		});
		faux.setResponses([
			async () => {
				await firstResponseGate;
				return fauxAssistantMessage("first answer");
			},
			fauxAssistantMessage("follow-up answer"),
			fauxAssistantMessage(selectDecision("finance", "Retirement analysis", "Analyze retirement options.")),
		]);

		const firstPrompt = runtimeHost.prompt("Analyze my retirement options.");
		await vi.waitFor(() => expect(runtimeHost.session.isStreaming).toBe(true));
		const queued = await runtimeHost.prompt("Include inflation assumptions.", { streamingBehavior: "followUp" });
		expect(queued.routing).toBe("bypassed");
		releaseFirstResponse?.();
		const result = await firstPrompt;

		expect(result).toMatchObject({ routing: "selected", activeProfileId: "finance" });
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("Include inflation assumptions");
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("follow-up answer");
		expect(faux.state.callCount).toBe(3);
	});

	it("bounds recent task context and excludes tool and custom messages", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "x".repeat(8_000), timestamp: Date.now() },
			{
				role: "toolResult",
				toolCallId: "tool-result",
				toolName: "read",
				content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "custom",
				customType: "hidden",
				content: "SECRET_CUSTOM_OUTPUT",
				display: false,
				timestamp: Date.now(),
			},
		];

		const excerpt = buildRecentTaskContext(messages);

		expect(excerpt.length).toBeLessThanOrEqual(6_000);
		expect(excerpt).not.toContain("SECRET_TOOL_OUTPUT");
		expect(excerpt).not.toContain("SECRET_CUSTOM_OUTPUT");
	});

	it("keeps auto settings automatic and pins only concrete defaults", () => {
		expect(resolveProfileRoutingMode(undefined, undefined, "auto")).toBe("auto");
		expect(resolveProfileRoutingMode("auto", "pinned", "coding")).toBe("auto");
		expect(resolveProfileRoutingMode(undefined, undefined, "finance")).toBe("pinned");
		expect(resolveProfileRoutingMode("research", undefined, undefined)).toBe("pinned");
	});

	it("expands skills and templates without bypassing command precedence or input hooks", () => {
		const tempDir = join(tmpdir(), `pi-routing-expansion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const skillPath = join(tempDir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: triage\ndescription: Health triage\n---\nAssess medical symptoms.", "utf-8");
		const extensionCommands = new Set<string>();
		const inputHook = vi.fn();
		const session = {
			extensionRunner: {
				getCommand: (name: string) => (extensionCommands.has(name) ? {} : undefined),
				emitInput: inputHook,
			},
			resourceLoader: {
				getSkills: () => ({
					skills: [{ name: "triage", filePath: skillPath, baseDir: tempDir }],
					diagnostics: [],
				}),
			},
			promptTemplates: [
				{ name: "portfolio", content: "Compare the $1 investment portfolio." },
				{ name: "settings", content: "This must not shadow the built-in command." },
			],
		} as unknown as AgentSession;

		try {
			expect(resolvePromptForProfileRouting(session, "/portfolio ACME")).toBe(
				"Compare the ACME investment portfolio.",
			);
			expect(resolvePromptForProfileRouting(session, "/skill:triage chest pain")).toContain(
				"Assess medical symptoms.",
			);
			expect(resolvePromptForProfileRouting(session, "/settings")).toBeUndefined();
			extensionCommands.add("skill:triage");
			expect(resolvePromptForProfileRouting(session, "/skill:triage chest pain")).toBeUndefined();
			expect(inputHook).not.toHaveBeenCalled();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
