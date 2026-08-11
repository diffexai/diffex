import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".diffex", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".diffex", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".diffex", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".diffex"), { recursive: true });
			writeFileSync(join(cwd, ".diffex", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, ".diffex"), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	it("treats profiles and EVOLVED.md as trusted resources but ignores legacy prompt files", () => {
		const piDir = join(cwd, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "SYSTEM.md"), "legacy system prompt");
		writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "legacy append prompt");

		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

		writeFileSync(join(piDir, "EVOLVED.md"), "bounded learned notes");
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

		rmSync(join(piDir, "EVOLVED.md"), { force: true });
		mkdirSync(join(piDir, "profiles"));
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});
});
