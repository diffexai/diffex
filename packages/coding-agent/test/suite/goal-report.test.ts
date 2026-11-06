import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { expect, it } from "vitest";
import { writeGoalReport } from "./goal-report.ts";

it("writes and appends reports while rejecting paths and symlinks outside report roots", () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex-report-"));
	try {
		const output = join(directory, "nested", "report.jsonl");
		writeGoalReport(output, "first\n");
		writeGoalReport(output, "second\n", true);
		expect(readFileSync(output, "utf8")).toBe("first\nsecond\n");
		const outside = join(parse(directory).root, "diffex-report-forbidden.jsonl");
		expect(() => writeGoalReport(outside, "no")).toThrow(/inside the repository/);
		const link = join(directory, "escape");
		symlinkSync(parse(directory).root, link, "dir");
		expect(() => writeGoalReport(join(link, "diffex-report-forbidden.jsonl"), "no")).toThrow(/symbolic link/);
		expect(existsSync(join(directory, "escape", "diffex-report-forbidden.jsonl"))).toBe(false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
