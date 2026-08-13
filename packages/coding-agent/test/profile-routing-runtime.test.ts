import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function routeDecision(
	decision: "stay" | "switch" | "create",
	profileId: string,
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		decision,
		profileId,
		confidence: 0.99,
		reason: decision === "stay" ? "The task continues in this profile." : "The user started a distinct task.",
		distinctTask: decision !== "stay",
		...overrides,
	});
}

describe("AgentSessionRuntime profile routing", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(
		profileRouting: "auto" | "pinned" | undefined = "auto",
		omitInitialProfileSelection = false,
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

		const runtimeRequests: Array<{ profile?: string; profileRouting?: "auto" | "pinned" }> = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
			profile,
			profileRouting: nextRouting,
			generatedProfiles,
		}) => {
			runtimeRequests.push({ profile, profileRouting: nextRouting });
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				modelRuntime,
				resourceLoaderOptions: {
					profile,
					generatedProfiles,
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
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			...(omitInitialProfileSelection ? {} : { profile: "coding", profileRouting }),
		});
		await runtimeHost.session.bindExtensions({});
		runtimeHost.setRebindSession(async (session) => {
			await session.bindExtensions({});
		});
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
		return { runtimeHost, faux, tempDir, dispose, runtimeRequests };
	}

	it("routes initial prompts and moves distinct tasks into a fresh linked runtime", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		let routerContext = "";
		faux.setResponses([
			fauxAssistantMessage(routeDecision("stay", "coding")),
			fauxAssistantMessage("coding answer"),
			(context) => {
				routerContext = JSON.stringify(context);
				return fauxAssistantMessage(
					routeDecision("switch", "finance", {
						handoff: "Answer the new portfolio question without carrying over coding context.",
					}),
				);
			},
			fauxAssistantMessage("finance answer"),
		]);

		const firstResult = await runtimeHost.prompt("Fix the parser bug.");
		const previousSessionFile = runtimeHost.session.sessionFile;
		expect(firstResult).toMatchObject({ routing: "stayed", activeProfileId: "coding" });
		expect(previousSessionFile).toBeTruthy();

		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "secret-result",
			toolName: "read",
			content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }],
			isError: false,
			timestamp: Date.now(),
		};
		runtimeHost.session.agent.state.messages.push(toolResult);
		const switches: ProfileSwitchEvent[] = [];
		runtimeHost.setProfileSwitchListener((event) => switches.push(event));

		const secondResult = await runtimeHost.prompt("Build a retirement portfolio for a separate task.");

		expect(routerContext).not.toContain("SECRET_TOOL_OUTPUT");
		expect(secondResult).toMatchObject({
			routing: "switched",
			activeProfileId: "finance",
			previousProfileId: "coding",
		});
		expect(runtimeHost.activeProfile.id).toBe("finance");
		expect(runtimeHost.session.sessionManager.getHeader()).toMatchObject({
			parentSession: previousSessionFile,
			profile: { id: "finance", routing: "auto" },
		});
		expect(switches).toEqual([
			{
				fromProfileId: "coding",
				toProfileId: "finance",
				reason: "The user started a distinct task.",
				generated: false,
			},
		]);
		const activeMessages = runtimeHost.session.messages;
		expect(JSON.stringify(activeMessages)).toContain("portfolio question");
		expect(JSON.stringify(activeMessages)).toContain("Build a retirement portfolio");
		expect(JSON.stringify(activeMessages)).toContain("finance answer");
		expect(JSON.stringify(activeMessages)).not.toContain("Fix the parser bug");
		expect(JSON.stringify(activeMessages)).not.toContain("SECRET_TOOL_OUTPUT");
		expect(faux.state.callCount).toBe(4);
	});

	it("selects a better profile from the first prompt without linking prior task history", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost("auto", true);
		const initialSessionFile = runtimeHost.session.sessionFile;
		faux.setResponses([
			fauxAssistantMessage(
				routeDecision("switch", "finance", {
					reason: "The first request is a finance task.",
					distinctTask: false,
				}),
			),
			fauxAssistantMessage("finance answer"),
		]);

		const result = await runtimeHost.prompt("Compare the cash-flow risk in these two investments.");

		expect(result).toMatchObject({
			routing: "switched",
			activeProfileId: "finance",
			previousProfileId: "general",
		});
		expect(runtimeHost.activeProfile.id).toBe("finance");
		expect(runtimeHost.session.sessionManager.getHeader()).toMatchObject({
			profile: { id: "finance", routing: "auto" },
		});
		expect(runtimeHost.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		expect(runtimeHost.session.sessionFile).toBe(initialSessionFile);
		expect(readdirSync(join(tempDir, "sessions")).filter((file) => file.endsWith(".jsonl"))).toHaveLength(1);
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("Compare the cash-flow risk");
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("finance answer");
		expect(faux.state.callCount).toBe(2);
	});

	it("bypasses routing while a profile is pinned", async () => {
		const { runtimeHost, faux } = await createRuntimeHost("pinned");
		faux.setResponses([fauxAssistantMessage("done")]);

		const result = await runtimeHost.prompt("Review this balance sheet.");

		expect(result).toEqual({ routing: "bypassed", activeProfileId: "coding" });
		expect(faux.state.callCount).toBe(1);
		expect(runtimeHost.activeProfile.id).toBe("coding");
	});

	it("lets the factory resolve its neutral profile and automatic routing mode", async () => {
		const { runtimeHost, runtimeRequests } = await createRuntimeHost(undefined, true);

		expect(runtimeRequests[0]).toEqual({ profile: undefined, profileRouting: undefined });
		expect(runtimeHost.activeProfile.id).toBe("general");
		expect(runtimeHost.profileRouting).toBe("auto");
		expect(runtimeHost.session.sessionManager.getHeader()?.profile?.routing).toBe("auto");
	});

	it("delivers the user prompt when routing fails", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		faux.setResponses([
			() => {
				throw new Error("router unavailable");
			},
			fauxAssistantMessage("fallback answer"),
		]);

		const result = await runtimeHost.prompt("Keep working on the parser.");

		expect(result).toMatchObject({ routing: "stayed", activeProfileId: "coding" });
		expect(runtimeHost.diagnostics.at(-1)?.message).toContain("router unavailable");
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("Keep working on the parser");
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("fallback answer");
		expect(faux.state.callCount).toBe(2);
	});

	it("waits for an active turn before a distinct follow-up replaces the session", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		let releaseFirstResponse: (() => void) | undefined;
		const firstResponseGate = new Promise<void>((resolveGate) => {
			releaseFirstResponse = resolveGate;
		});
		faux.setResponses([
			fauxAssistantMessage(routeDecision("stay", "coding")),
			async () => {
				await firstResponseGate;
				return fauxAssistantMessage("coding answer");
			},
			fauxAssistantMessage(routeDecision("switch", "finance")),
			fauxAssistantMessage("finance answer"),
		]);

		const firstPrompt = runtimeHost.prompt("Fix the parser bug.");
		await vi.waitFor(() => expect(runtimeHost.session.isStreaming).toBe(true));
		let followUpSettled = false;
		const followUp = runtimeHost
			.prompt("For a separate task, analyze my retirement portfolio.", { streamingBehavior: "followUp" })
			.finally(() => {
				followUpSettled = true;
			});
		await vi.waitFor(() => expect(faux.state.callCount).toBe(3));

		expect(followUpSettled).toBe(false);
		expect(runtimeHost.activeProfile.id).toBe("coding");
		releaseFirstResponse?.();
		await firstPrompt;
		const result = await followUp;

		expect(result).toMatchObject({ routing: "switched", activeProfileId: "finance" });
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("analyze my retirement portfolio");
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("finance answer");
	});

	it("routes a distinct steer and delivers it after aborting the replaced turn", async () => {
		const { runtimeHost, faux } = await createRuntimeHost();
		let releaseOldResponse: (() => void) | undefined;
		faux.setResponses([
			fauxAssistantMessage(routeDecision("stay", "coding")),
			(_context, options) =>
				new Promise((resolveResponse) => {
					let resolved = false;
					const finish = () => {
						if (resolved) return;
						resolved = true;
						resolveResponse(fauxAssistantMessage("old turn stopped"));
					};
					releaseOldResponse = finish;
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				}),
			fauxAssistantMessage(routeDecision("switch", "legal")),
			fauxAssistantMessage("legal answer"),
		]);

		const firstPrompt = runtimeHost.prompt("Fix the parser bug.");
		await vi.waitFor(() => expect(runtimeHost.session.isStreaming).toBe(true));
		const result = await runtimeHost.prompt("For a separate task, review this contract clause.", {
			streamingBehavior: "steer",
		});
		releaseOldResponse?.();
		await firstPrompt;

		expect(result).toMatchObject({ routing: "switched", activeProfileId: "legal" });
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("review this contract clause");
		expect(JSON.stringify(runtimeHost.session.messages)).toContain("legal answer");
	});

	it("finalizes a generated profile before a replacement runtime reuses it", async () => {
		const { runtimeHost, faux, tempDir } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage(
				routeDecision("create", "supply-chain", {
					generatedLabel: "Supply Chain",
					generatedDescription: "Analyze supply chain planning and operations.",
				}),
			),
			fauxAssistantMessage("supply chain answer"),
		]);
		await runtimeHost.prompt("Start a separate supply chain planning task.");
		const original = runtimeHost.activeProfile;
		appendEvolvedNote({
			agentDir: tempDir,
			profileId: original.id,
			category: "response style",
			provenance: "test",
			content: "State inventory assumptions before recommendations.",
			scope: "global",
		});

		await runtimeHost.newSession({ profileRouting: "auto" });

		const reused = runtimeHost.activeProfile;
		expect(reused.id).toBe(original.id);
		expect(reused.hash).not.toBe(original.hash);
		expect(reused.prompt).toContain("State inventory assumptions before recommendations.");
		expect(runtimeHost.session.sessionManager.getHeader()?.profile?.hash).toBe(reused.hash);
	});

	it("finalizes a generated profile from notes loaded at shutdown", async () => {
		const { runtimeHost, faux, tempDir, dispose } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage(
				routeDecision("create", "supply-chain", {
					generatedLabel: "Supply Chain",
					generatedDescription: "Analyze supply chain planning and operations.",
				}),
			),
			fauxAssistantMessage("supply chain answer"),
		]);

		const result = await runtimeHost.prompt("Start a separate supply chain planning task.");
		expect(result.routing).toBe("created");
		const profile = runtimeHost.activeProfile;
		expect(profile.origin).toBe("generated");
		appendEvolvedNote({
			agentDir: tempDir,
			profileId: profile.id,
			category: "response style",
			provenance: "test",
			content: "Always state inventory assumptions explicitly.",
			scope: "global",
		});

		await dispose();

		if (!profile.source.promptPath) throw new Error("Generated profile prompt path is missing");
		const prompt = readFileSync(profile.source.promptPath, "utf-8");
		expect(prompt).toContain("## Evolved guidance");
		expect(prompt).toContain("Always state inventory assumptions explicitly.");
		expect(runtimeHost.session.sessionManager.getHeader()?.profile?.hash).not.toBe(profile.hash);
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

	it("expands skills and templates for routing without bypassing command precedence or input hooks", () => {
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
