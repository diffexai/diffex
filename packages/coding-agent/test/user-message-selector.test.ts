import { getGlyphs, visibleWidth } from "@earendil-works/diffex-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("UserMessageSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders one width-safe row per message", () => {
		const selector = new UserMessageSelectorComponent(
			[
				{ id: "one", text: "First message" },
				{ id: "two", text: "Second message with a long continuation that must truncate" },
				{ id: "three", text: "Third message" },
			],
			() => {},
			() => {},
		);

		const rendered = selector
			.getMessageList()
			.render(24)
			.map((line) => stripAnsi(line));

		expect(rendered).toHaveLength(3);
		expect(rendered.every((line) => line.length > 0)).toBe(true);
		expect(rendered.every((line) => visibleWidth(line) <= 24)).toBe(true);
		expect(rendered[2]).toContain(`${getGlyphs().selected} Third message`);
		expect(rendered[2]).toContain("3/3");
	});
});
