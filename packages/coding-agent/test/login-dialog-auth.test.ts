import { setKeybindings, type TUI } from "@diffexai/diffex-tui";
import { beforeAll, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

beforeAll(() => initTheme("dark"));

it("opens the complete sign-in URL while redacting the ID token from terminal output and hyperlinks", () => {
	const dialog = new LoginDialogComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		"openai-codex",
		() => {},
		"ChatGPT",
	);
	const url =
		"https://auth.openai.com/api/accounts/authorize?client_id=oaiapp_diffex&id_token_hint=private-identity-token&state=state";
	dialog.showAuth(url, "Continue with ChatGPT");
	expect(openBrowser).toHaveBeenCalledWith(url);
	const rendered = dialog.render(100).join("\n");
	expect(rendered).not.toContain("private-identity-token");
	expect(rendered).not.toContain("id_token_hint");
	expect(rendered).toContain("Continue with ChatGPT");
	expect(rendered).toContain("oaiapp_diffex");
});

it("cancels with the login cancellation reason used by the UI", () => {
	setKeybindings(new KeybindingsManager());
	const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "openai-codex", () => {});
	dialog.handleInput("\x1b");
	expect(dialog.signal.aborted).toBe(true);
	expect(dialog.signal.reason).toMatchObject({ message: "Login cancelled" });
});
