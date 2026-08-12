import { describe, expect, test, vi } from "vitest";
import { BUILTIN_TASK_PROFILES, TaskProfileRegistry } from "../src/core/profiles.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const handleProfileCommand = Reflect.get(InteractiveMode.prototype, "handleProfileCommand") as (
	this: ProfileCommandContext,
	selection?: string,
) => Promise<void>;

interface ProfileCommandContext {
	session: {
		isStreaming: boolean;
		isCompacting: boolean;
		sessionFile?: string;
		messages: Array<{ role: "user" | "assistant" }>;
		resourceLoader: {
			getProfiles: () => { profiles: typeof BUILTIN_TASK_PROFILES; registry: TaskProfileRegistry };
		};
	};
	runtimeHost: {
		activeProfile: (typeof BUILTIN_TASK_PROFILES)[number];
		profileRouting: "auto" | "pinned";
		setProfileRouting: ReturnType<typeof vi.fn>;
		newSession: ReturnType<typeof vi.fn>;
	};
	showExtensionSelector: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
}

function createContext(): ProfileCommandContext {
	const coding = BUILTIN_TASK_PROFILES.find((profile) => profile.id === "coding");
	if (!coding) throw new Error("Missing coding profile");
	const registry = new TaskProfileRegistry();
	return {
		session: {
			isStreaming: false,
			isCompacting: false,
			sessionFile: "/tmp/coding-session.jsonl",
			messages: [{ role: "user" }],
			resourceLoader: {
				getProfiles: () => ({ profiles: BUILTIN_TASK_PROFILES, registry }),
			},
		},
		runtimeHost: {
			activeProfile: coding,
			profileRouting: "pinned",
			setProfileRouting: vi.fn(),
			newSession: vi.fn().mockResolvedValue({ cancelled: false }),
		},
		showExtensionSelector: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	};
}

describe("InteractiveMode task profile command", () => {
	test("starts automatic routing in a fresh DEFAULT session", async () => {
		const context = createContext();

		await handleProfileCommand.call(context, "auto");

		expect(context.runtimeHost.setProfileRouting).not.toHaveBeenCalled();
		expect(context.runtimeHost.newSession).toHaveBeenCalledWith({
			profile: "general",
			profileRouting: "auto",
		});
		expect(context.showStatus).toHaveBeenCalledWith("Automatic profile routing enabled from DEFAULT");
	});

	test("opens the selector and pins its selected profile in a fresh linked session", async () => {
		const context = createContext();
		const finance = BUILTIN_TASK_PROFILES.find((profile) => profile.id === "finance");
		if (!finance) throw new Error("Missing finance profile");
		context.showExtensionSelector.mockResolvedValue(`${finance.id} - ${finance.name}`);

		await handleProfileCommand.call(context);

		expect(context.showExtensionSelector).toHaveBeenCalledWith(
			"Task profile: coding (pinned)",
			expect.arrayContaining(["auto - automatic routing", `${finance.id} - ${finance.name}`]),
		);
		expect(context.runtimeHost.newSession).toHaveBeenCalledWith({
			parentSession: "/tmp/coding-session.jsonl",
			profile: "finance",
			profileRouting: "pinned",
		});
		expect(context.showStatus).toHaveBeenCalledWith("Task profile pinned: finance");
	});

	test("pins the active profile in place and rejects unknown profile IDs", async () => {
		const context = createContext();

		await handleProfileCommand.call(context, "coding");
		expect(context.runtimeHost.setProfileRouting).toHaveBeenCalledWith("pinned");
		expect(context.runtimeHost.newSession).not.toHaveBeenCalled();

		await handleProfileCommand.call(context, "not-a-profile");
		expect(context.showError).toHaveBeenCalledWith("Unknown task profile: not-a-profile");
	});
});
