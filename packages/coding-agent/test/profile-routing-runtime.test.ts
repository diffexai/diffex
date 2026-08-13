import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/diffex-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/diffex-ai/compat";
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

	async function createRuntimeHost(profileRouting: "auto" | "pinned" = "auto", profile = "coding") {
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
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
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
