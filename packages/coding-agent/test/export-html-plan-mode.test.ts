import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("export HTML native plan rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("renders and indexes plan artifacts while hiding plan bookkeeping by default", () => {
		expect(templateJs).toContain("parts.push('plan', entry.plan.title, entry.plan.markdown)");
		expect(templateJs).toMatch(
			/const isSettingsEntry = \[[\s\S]*?'collaboration_mode_change',[\s\S]*?'plan_resolution'[\s\S]*?\]\.includes\(entry\.type\);/,
		);
		expect(templateJs).toMatch(/\[mode: \$\{escapeHtml\(entry\.mode\)\}\]/);
		expect(templateJs).toMatch(/\[plan resolution: \$\{escapeHtml\(entry\.resolution\)\}\]/);
		expect(templateJs).toContain("escapeHtml(truncate(normalize(entry.plan.title)))");
		expect(templateJs).toMatch(/Plan: \$\{escapeHtml\(entry\.plan\.title\)\}/);
		expect(templateJs).toContain("safeMarkedParse(entry.plan.markdown)");
	});
});
