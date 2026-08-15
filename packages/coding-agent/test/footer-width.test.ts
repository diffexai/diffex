import { Container, Text, visibleWidth } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import {
	FooterComponent,
	FooterTaskContextComponent,
	formatCwdForFooter,
} from "../src/modes/interactive/components/footer.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	collaborationMode?: "default" | "plan";
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
		collaborationMode: options.collaborationMode ?? "default",
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

const defaultTaskContext = () => ({
	profileName: "General",
	profileRouting: "auto" as const,
});

interface ExtensionFooterContext {
	customFooter?: { dispose?: () => void };
	footerContainer: Container;
	footerTaskContext: FooterTaskContextComponent;
	footer: Text;
	footerDataProvider: ReadonlyFooterDataProvider;
	ui: { requestRender: () => void };
}

const setExtensionFooter = Reflect.get(InteractiveMode.prototype, "setExtensionFooter") as (
	this: ExtensionFooterContext,
	factory: (() => Text) | undefined,
) => void;

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1), defaultTaskContext);

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2), defaultTaskContext);

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows model, thinking level, context usage, and context window", () => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5.5",
			thinkingLevel: "medium",
		});
		const footer = new FooterComponent(session, createFooterData(1), defaultTaskContext);

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toBe("gpt-5.5 medium • Context 12.3% used • 200k window");
	});

	it("reads the active profile and harness on every render", () => {
		const session = createSession({ sessionName: "" });
		const taskContext: {
			profileName: string;
			profileRouting: "auto" | "pinned";
			harnessName?: string;
		} = {
			profileName: "General",
			profileRouting: "auto",
		};
		const footer = new FooterComponent(session, createFooterData(1), () => taskContext);

		expect(stripAnsi(footer.render(80)[0] ?? "")).toBe("Profile: General (auto) • Harness: not selected");

		taskContext.profileName = "Coding";
		taskContext.profileRouting = "pinned";
		taskContext.harnessName = "Financial Decision Visualizer";
		expect(stripAnsi(footer.render(80)[0] ?? "")).toBe(
			"Profile: Coding (pinned) • Harness: Financial Decision Visualizer",
		);
	});

	it("does not show the project directory in the footer", () => {
		const session = createSession({
			sessionName: "work",
		});
		const footer = new FooterComponent(session, createFooterData(1), defaultTaskContext);

		expect(stripAnsi(footer.render(120).join("\n"))).not.toContain("/tmp/project");
	});

	it("keeps the plan-mode status visible at 60 columns", () => {
		const session = createSession({
			sessionName: "",
			modelId: "claude-opus-4-1",
			thinkingLevel: "high",
			collaborationMode: "plan",
		});
		const footer = new FooterComponent(session, createFooterData(1), () => ({
			profileName: "Finance",
			profileRouting: "auto",
			harnessName: "Financial Decision Visualizer With A Deliberately Long Name",
		}));

		const lines = footer.render(60).map(stripAnsi);
		expect(lines[0]).toMatch(/^\[plan\] Profile: Finance \(auto\) • Harness: Financial/);
		expect(lines[1]).toBe("claude-opus-4-1 high • Context 12.3% used • 200k window");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("keeps both long profile and harness names visible at 60 columns", () => {
		const session = createSession({ sessionName: "", collaborationMode: "plan" });
		const taskContext = new FooterTaskContextComponent(session, () => ({
			profileName: "Specialized Finance Profile With A Deliberately Long Name",
			profileRouting: "auto",
			harnessName: "Financial Decision Visualizer With A Deliberately Long Name",
		}));

		const line = stripAnsi(taskContext.render(60)[0] ?? "");
		expect(line).toMatch(/^\[plan\] Profile: Spec.*\.\.\. \(auto\) • Harness: Fin.*\.\.\.$/);
		expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("strips terminal sequences from profile and harness names", () => {
		const session = createSession({ sessionName: "" });
		const taskContext = new FooterTaskContextComponent(session, () => ({
			profileName: "\u001b]8;;https://example.invalid\u0007Finance\u001b]8;;\u0007\u001b[2J",
			profileRouting: "pinned",
			harnessName: "Decision\u001b[31m Visualizer\u001b[0m\u0000",
		}));

		const line = stripAnsi(taskContext.render(80)[0] ?? "");
		expect(line).toBe("Profile: Finance (pinned) • Harness: Decision Visualizer");
		expect(line).not.toContain("example.invalid");
	});

	it("keeps task context mounted above a custom extension footer", () => {
		const session = createSession({ sessionName: "", collaborationMode: "plan" });
		const footerContainer = new Container();
		const footerTaskContext = new FooterTaskContextComponent(session, () => ({
			profileName: "Finance",
			profileRouting: "auto",
			harnessName: "Decision Visualizer",
		}));
		const context: ExtensionFooterContext = {
			footerContainer,
			footerTaskContext,
			footer: new Text("built-in footer"),
			footerDataProvider: createFooterData(1),
			ui: { requestRender: () => {} },
		};

		setExtensionFooter.call(context, () => new Text("custom footer", 0, 0));

		const rendered = footerContainer.render(60).map((line) => stripAnsi(line).trimEnd());
		expect(rendered).toEqual(["[plan] Profile: Finance (auto) • Harness: Decision Visual...", "custom footer"]);
	});
});
