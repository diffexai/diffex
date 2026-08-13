import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	BOOTSTRAP_TASK_PROFILE_ID,
	BUILTIN_TASK_PROFILES,
	DEFAULT_TASK_PROFILE_ID,
	loadTaskProfiles,
	resolveTaskProfileManifest,
	resolveTaskProfileSelection,
	TaskProfileRegistry,
} from "../src/core/profiles.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-profiles-"));
	temporaryDirectories.push(directory);
	return directory;
}

function manifest(id: string, prompt: string = "Follow this profile."): Record<string, unknown> {
	return {
		schemaVersion: 1,
		id,
		name: id,
		description: `${id} tasks`,
		prompt,
		routing: { description: `${id} routing`, examples: [`Do ${id}`], keywords: [id] },
		tools: { default: ["read"], required: [], denied: ["write"] },
		guardrails: {
			highStakes: false,
			requireHumanReview: false,
			requireCurrentSources: false,
			disallowedActions: [],
			instructions: ["State uncertainty."],
		},
	};
}

function writeManifest(directory: string, value: Record<string, unknown>): string {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "profile.json");
	writeFileSync(path, JSON.stringify(value), "utf-8");
	return path;
}

describe("built-in task profiles", () => {
	test("provides the immutable bootstrap and domain profiles", () => {
		expect(BUILTIN_TASK_PROFILES.map((profile) => profile.id)).toEqual([
			"general",
			"coding",
			"finance",
			"healthcare",
			"legal",
			"research",
		]);
		expect(BOOTSTRAP_TASK_PROFILE_ID).toBe("general");
		expect(DEFAULT_TASK_PROFILE_ID).toBe(BOOTSTRAP_TASK_PROFILE_ID);
		expect(BUILTIN_TASK_PROFILES.every((profile) => profile.immutable && Object.isFrozen(profile))).toBe(true);
		for (const id of ["finance", "healthcare", "legal", "research"]) {
			expect(BUILTIN_TASK_PROFILES.find((profile) => profile.id === id)?.tools).toEqual({
				default: ["read", "write", "edit"],
				required: [],
				denied: ["bash"],
			});
		}
		expect(BUILTIN_TASK_PROFILES.find((profile) => profile.id === "general")?.tools).toEqual({
			default: ["read", "bash", "edit", "write"],
			required: [],
			denied: [],
		});
		expect(BUILTIN_TASK_PROFILES.find((profile) => profile.id === "coding")?.tools.default).toEqual([
			"read",
			"bash",
			"edit",
			"write",
		]);
	});
});

describe("profile manifests", () => {
	test("loads literal prompts and resolves prompt files relative to profile.json", () => {
		const root = temporaryDirectory();
		const literalPath = writeManifest(join(root, "literal"), manifest("literal"));
		const fileDirectory = join(root, "file");
		const fileManifest = manifest("from-file");
		delete fileManifest.prompt;
		fileManifest.promptFile = "PROMPT.md";
		writeFileSync(writeManifest(fileDirectory, fileManifest), JSON.stringify(fileManifest), "utf-8");
		writeFileSync(join(fileDirectory, "PROMPT.md"), "Prompt loaded from disk.", "utf-8");

		const result = loadTaskProfiles([literalPath, fileDirectory]);

		expect(result.diagnostics).toEqual([]);
		expect(result.registry.get("literal")?.prompt).toBe("Follow this profile.");
		expect(result.registry.get("from-file")?.prompt).toBe("Prompt loaded from disk.");
		expect(result.registry.get("from-file")?.source.promptPath).toBe(join(fileDirectory, "PROMPT.md"));
		expect(result.registry.get("from-file")?.hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test("rejects invalid IDs, empty prompts, arrays, and conflicting tool policies", () => {
		const value = manifest("Bad ID", " ");
		value.routing = { description: "route", examples: "not-an-array", keywords: [] };
		value.tools = { default: ["read", "write"], required: [], denied: ["write"] };
		value.context = { fileNames: ["../../.env"], label: "Unsafe" };

		const result = resolveTaskProfileManifest(value, {
			origin: "user",
			sourcePath: "/tmp/invalid-profile.json",
		});

		expect(result.profile).toBeUndefined();
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				"id must be at most 64 characters and contain lowercase letters, numbers, and single hyphens only",
				"prompt must be a non-empty string",
				"routing.examples must be an array of non-empty strings",
				"tools policy both enables and denies: write",
				"context.fileNames must contain Markdown file names without path separators",
			]),
		);
	});

	test("rejects prompt files outside the profile directory", () => {
		const root = temporaryDirectory();
		const directory = join(root, "escape");
		const value = manifest("escape");
		delete value.prompt;
		value.promptFile = "../outside.md";
		writeFileSync(join(root, "outside.md"), "External prompt", "utf-8");
		const path = writeManifest(directory, value);

		const result = loadTaskProfiles([path]);

		expect(result.registry.get("escape")).toBeUndefined();
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
			"promptFile must stay inside the profile directory",
		);
	});

	test("keeps the first profile on deterministic ID collisions and never replaces a built-in", () => {
		const root = temporaryDirectory();
		const first = writeManifest(join(root, "first"), manifest("duplicate", "first"));
		const second = writeManifest(join(root, "second"), manifest("duplicate", "second"));
		const builtinCollision = writeManifest(join(root, "general"), manifest("general", "replacement"));

		const result = loadTaskProfiles([first, second, builtinCollision]);

		expect(result.registry.get("duplicate")?.prompt).toBe("first");
		expect(result.registry.get("general")?.origin).toBe("builtin");
		expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "collision")).toHaveLength(2);
		expect(result.diagnostics.filter((diagnostic) => diagnostic.type === "collision")[0]?.collision).toEqual({
			id: "duplicate",
			winnerSource: first,
			loserSource: second,
		});
	});

	test("validates, clones, and deeply freezes injected resolved profiles", () => {
		const root = temporaryDirectory();
		const path = writeManifest(join(root, "injected"), manifest("injected"));
		const original = loadTaskProfiles([path]).registry.get("injected");
		if (!original) throw new Error("Missing injected profile fixture");
		const injected = structuredClone(original);

		const registry = new TaskProfileRegistry([injected]);
		const registered = registry.get("injected");
		if (!registered) throw new Error("Injected profile was not registered");

		expect(registered).not.toBe(injected);
		expect(registered.routing).not.toBe(injected.routing);
		expect(registered.tools).not.toBe(injected.tools);
		expect(registered.guardrails).not.toBe(injected.guardrails);
		expect(registered.source).not.toBe(injected.source);
		expect(
			[
				registered,
				registered.routing,
				registered.routing.examples,
				registered.tools,
				registered.tools.denied,
				registered.guardrails,
				registered.guardrails.instructions,
				registered.context,
				registered.context.fileNames,
				registered.source,
			].every(Object.isFrozen),
		).toBe(true);
		expect(Object.isFrozen(injected)).toBe(false);

		injected.routing.examples.push("Mutated routing");
		injected.tools.denied.push("bash");
		injected.guardrails.instructions.push("Mutated guardrail");
		injected.source.label = "mutated";
		expect(registered.routing.examples).not.toContain("Mutated routing");
		expect(registered.tools.denied).not.toContain("bash");
		expect(registered.guardrails.instructions).not.toContain("Mutated guardrail");
		expect(registered.source.label).not.toBe("mutated");
	});

	test("rejects invalid injected profile integrity metadata", () => {
		const root = temporaryDirectory();
		const path = writeManifest(join(root, "integrity"), manifest("integrity"));
		const original = loadTaskProfiles([path]).registry.get("integrity");
		if (!original) throw new Error("Missing integrity profile fixture");
		const invalidHash = structuredClone(original);
		invalidHash.hash = "0".repeat(64);
		const invalidImmutable = structuredClone(original);
		invalidImmutable.immutable = false;

		const result = loadTaskProfiles([{ profile: invalidHash }, { profile: invalidImmutable }]);

		expect(result.registry.get("integrity")).toBeUndefined();
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				"injected profile hash does not match its contents",
				"injected profile immutable flag does not match its origin",
			]),
		);
	});
});

describe("profile selection", () => {
	test("defers undefined and auto selections to automatic routing", () => {
		expect(resolveTaskProfileSelection(undefined).automatic).toBe(true);
		expect(resolveTaskProfileSelection("auto").automatic).toBe(true);
		expect(resolveTaskProfileSelection(undefined).profile).toBeUndefined();
	});

	test("resolves IDs and filesystem directories without mutating the original registry", () => {
		const root = temporaryDirectory();
		writeManifest(join(root, "custom"), manifest("custom"));
		const original = loadTaskProfiles().registry;

		const byId = resolveTaskProfileSelection("coding", { registry: original });
		const byPath = resolveTaskProfileSelection("custom", { registry: original, cwd: root });

		expect(byId.profile?.id).toBe("coding");
		expect(byPath.profile?.id).toBe("custom");
		expect(original.has("custom")).toBe(false);
		expect(byPath.registry.has("custom")).toBe(true);
	});
});
