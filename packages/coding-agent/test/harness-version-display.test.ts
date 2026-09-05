import { describe, expect, it } from "vitest";
import {
	countHarnessMemoryLessons,
	formatHarnessVersionInventory,
	formatHarnessVersionLabel,
	formatHarnessVersionPickerLabel,
	formatHarnessVersionReference,
	sanitizeDisplayText,
} from "../src/modes/interactive/components/harness-version-display.ts";

describe("harness version display", () => {
	it("counts numbered lessons rather than headings or continuation lines", () => {
		expect(
			countHarnessMemoryLessons(
				"# Memory\n\nLesson 1: One.\nContinuation.\n\n- Lesson 2: Two.\n\n3. Lesson 3: Three.",
			),
		).toBe(3);
		expect(countHarnessMemoryLessons("")).toBe(0);
		expect(countHarnessMemoryLessons("```\nLesson 9: Example only.\n```\n\nLesson 1: Real lesson.")).toBe(1);
		expect(formatHarnessVersionInventory("```unclosed", 0)).toBe("? lessons · 0 skills");
		expect(formatHarnessVersionInventory("Lesson 1: One.", 2)).toBe("1 lessons · 2 skills");
		expect(formatHarnessVersionInventory(undefined, undefined)).toBe("? lessons · ? skills");
	});

	it("distinguishes skill activations without inventing missing provenance", () => {
		const info = {
			version: "sha256:123",
			kind: "evolved" as const,
			evolvedAt: null,
			evolvedIn: null,
			origin: "skill" as const,
		};
		expect(formatHarnessVersionLabel(info, info.version)).toBe("[current] Evolved Diffex Agent [skill activation]");
		expect(formatHarnessVersionLabel({ ...info, origin: "memory" }, null)).toBe("Evolved Diffex Agent");
		expect(formatHarnessVersionReference(null, [], null)).toBe("none");
	});

	it("shares a hash and complete inventory label between picker rows and completion statuses", () => {
		const info = { version: `sha256:${"a".repeat(64)}`, kind: "evolved" as const, evolvedAt: null, evolvedIn: null };
		expect(formatHarnessVersionPickerLabel(info, info.version, "Lesson 1: Verify selection.", 2)).toBe(
			"unknown time · 1 lessons · 2 skills · aaaaaaaaaaaa [current]",
		);
	});

	it("puts known timestamps first and leaves origin and provenance out of compact rows", () => {
		const info = {
			version: `sha256:${"a".repeat(64)}`,
			kind: "evolved" as const,
			evolvedAt: new Date(2026, 7, 20, 20, 38).toISOString(),
			evolvedIn: "/projects/long/path",
			origin: "skill" as const,
		};
		expect(
			formatHarnessVersionPickerLabel(info, info.version, "Lesson 1: Verify selection.", 3, new Date(2026, 7, 21)),
		).toBe("8/20 at 8:38 pm · 1 lessons · 3 skills · aaaaaaaaaaaa [current]");
		expect(formatHarnessVersionPickerLabel({ ...info, evolvedAt: "invalid" }, null, "", 0)).toBe(
			"unknown time · 0 lessons · 0 skills · aaaaaaaaaaaa",
		);
	});

	it("sanitizes terminal controls in provenance", () => {
		expect(sanitizeDisplayText("bad\u001b[2J\r\ntext\u202e")).toBe("bad [2J  text ");
		const info = {
			version: "test",
			kind: "evolved" as const,
			evolvedAt: "unknown\u001b[2J",
			evolvedIn: "/tmp\runsafe",
		};
		expect(formatHarnessVersionLabel(info, null)).toBe("Evolved Diffex Agent unknown [2J: /tmp unsafe");
	});
});
