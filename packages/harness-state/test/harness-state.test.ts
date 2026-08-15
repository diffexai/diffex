import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Check } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import {
	type HarnessState,
	type HarnessStateManifest,
	HarnessStateManifestSchema,
	HarnessStateSchema,
	loadDefaultHarnessState,
	loadHarnessState,
	saveHarnessState,
} from "../src/index.ts";

const DEFAULT_PROMPT =
	"You are an expert coding assistant operating inside Diffex, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nGuidelines:\n- Be concise in your responses\n- Show file paths clearly when working with files\n";
const temporaryRoots: string[] = [];

function createManifest(prompt: string): string {
	const digest = createHash("sha256").update(prompt, "utf8").digest("hex");
	return `{"contentHash":"sha256:${digest}"}\n`;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTemporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "diffex-harness-state-test-"));
	temporaryRoots.push(root);
	return root;
}

async function createBundle(
	root: string,
	name = "state",
	manifest: string | Uint8Array = createManifest("Act carefully.\n"),
	prompt: string | Uint8Array = "Act carefully.\n",
): Promise<string> {
	const bundlePath = join(root, name);
	await mkdir(bundlePath);
	await writeFile(join(bundlePath, "manifest.json"), manifest);
	await writeFile(join(bundlePath, "EVOLVE.md"), prompt);
	return bundlePath;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function assertReadonlyTypes(state: HarnessState, manifest: HarnessStateManifest): void {
	// @ts-expect-error HarnessState fields are readonly.
	state.systemPrompt = "changed";
	// @ts-expect-error HarnessStateManifest fields are readonly.
	manifest.contentHash = "sha256:changed";
}
void assertReadonlyTypes;

describe("schemas", () => {
	test("exports strict schemas with readonly inferred fields", () => {
		expect(Check(HarnessStateSchema, { systemPrompt: "Work carefully." })).toBe(true);
		expect(
			Check(HarnessStateManifestSchema, {
				contentHash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			}),
		).toBe(true);
		expect(Check(HarnessStateSchema, { systemPrompt: "Work.", extra: true })).toBe(false);
		expect(
			Check(HarnessStateManifestSchema, {
				contentHash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				extra: true,
			}),
		).toBe(false);
	});

	test.each([
		["blank prompt", { systemPrompt: "" }],
		["whitespace-only prompt", { systemPrompt: " \t\r\n" }],
		["leading U+FEFF prompt", { systemPrompt: "\uFEFFWork." }],
	] as const)("rejects %s", (_label, state) => {
		expect(Check(HarnessStateSchema, state)).toBe(false);
	});

	test.each([
		["wrong algorithm", { contentHash: "sha1:0123456789abcdef0123456789abcdef01234567" }],
		["short digest", { contentHash: "sha256:0123456789abcdef" }],
		["uppercase digest", { contentHash: "sha256:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF" }],
		["missing content hash", {}],
	] as const)("rejects %s", (_label, manifest) => {
		expect(Check(HarnessStateManifestSchema, manifest)).toBe(false);
	});
});

describe("default bundle", () => {
	test("loads the exact clean default through normal validation", async () => {
		const state = await loadDefaultHarnessState();
		expect(state).toEqual({ systemPrompt: DEFAULT_PROMPT });
		expect(Object.isFrozen(state)).toBe(false);
	});
});

describe("saving and round trips", () => {
	test.each([
		["Unicode", "Inspect caf\u00e9, \u6c34, and \u{10151}."],
		["LF", "First line\nSecond line\n"],
		["CRLF", "First line\r\nSecond line\r\n"],
		["multiline", "One\n\nThree\nFour"],
		["trailing whitespace", "Keep this exactly.  \n\t "],
	] as const)("preserves %s prompt content verbatim", async (_label, systemPrompt) => {
		const root = await createTemporaryRoot();
		const destination = join(root, "saved-state");
		await saveHarnessState({ systemPrompt }, destination);

		expect(await readFile(join(destination, "manifest.json"), "utf8")).toBe(createManifest(systemPrompt));
		expect(await readFile(join(destination, "EVOLVE.md"), "utf8")).toBe(systemPrompt);
		expect(await loadHarnessState(destination)).toEqual({ systemPrompt });
	});

	test("validates state before filesystem access", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "missing-parent", "state");
		await expect(saveHarnessState({ systemPrompt: "   " }, destination)).rejects.toThrow(/invalid harness state/i);
		expect(await pathExists(destination)).toBe(false);
	});

	test("requires an existing directory parent", async () => {
		const root = await createTemporaryRoot();
		const parentFile = join(root, "parent-file");
		await writeFile(parentFile, "not a directory");
		await expect(saveHarnessState({ systemPrompt: "Valid." }, join(parentFile, "state"))).rejects.toThrow();
	});

	test.each(["file", "directory"] as const)("refuses to overwrite an existing %s destination", async (kind) => {
		const root = await createTemporaryRoot();
		const destination = join(root, "state");
		if (kind === "file") await writeFile(destination, "original");
		else await mkdir(destination);

		await expect(saveHarnessState({ systemPrompt: "Replacement." }, destination)).rejects.toThrow(/already exists/i);
		if (kind === "file") expect(await readFile(destination, "utf8")).toBe("original");
		else expect(await readdir(destination)).toEqual([]);
	});

	test("refuses a dangling linked destination", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "state");
		await symlink(join(root, "missing-target"), destination, process.platform === "win32" ? "junction" : "dir");
		await expect(saveHarnessState({ systemPrompt: "Replacement." }, destination)).rejects.toThrow(/already exists/i);
	});

	test("cleans its staged directory after a late failure without exposing a partial bundle", async () => {
		const root = await createTemporaryRoot();
		const destination = join(root, "state");
		const temporaryPrefix = `.${basename(destination)}.harness-state.tmp-`;
		const saving = saveHarnessState({ systemPrompt: "x".repeat(16 * 1024 * 1024) }, destination).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		let stagedPath: string | undefined;
		for (let attempt = 0; attempt < 1_000; attempt++) {
			const stagedName = (await readdir(root)).find((entry) => entry.startsWith(temporaryPrefix));
			if (stagedName !== undefined) {
				stagedPath = join(root, stagedName);
				break;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
		}
		expect(stagedPath).toBeDefined();

		await mkdir(destination);
		await writeFile(join(destination, "unrelated"), "preserved");
		const result = await saving;
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected the concurrent destination to make saving fail");
		expect(result.error).toBeInstanceOf(Error);
		expect(await readdir(destination)).toEqual(["unrelated"]);
		expect((await readdir(root)).filter((entry) => entry.startsWith(temporaryPrefix))).toEqual([]);
	});
});

describe("bundle layout", () => {
	test("rejects a missing root", async () => {
		const root = await createTemporaryRoot();
		await expect(loadHarnessState(join(root, "missing"))).rejects.toThrow();
	});

	test("rejects a non-directory root", async () => {
		const root = await createTemporaryRoot();
		const bundlePath = join(root, "state");
		await writeFile(bundlePath, "not a directory");
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/direct directory/i);
	});

	test("rejects a linked root", async () => {
		const root = await createTemporaryRoot();
		const target = await createBundle(root, "target");
		const bundlePath = join(root, "linked-state");
		await symlink(target, bundlePath, process.platform === "win32" ? "junction" : "dir");
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/direct directory/i);
	});

	test.each(["manifest.json", "EVOLVE.md"] as const)("rejects a missing %s entry", async (missingName) => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root);
		await rm(join(bundlePath, missingName));
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/exactly manifest\.json and EVOLVE\.md/i);
	});

	test("rejects additional entries", async () => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root);
		await writeFile(join(bundlePath, "extra.txt"), "extra");
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/exactly manifest\.json and EVOLVE\.md/i);
	});

	test("rejects mis-cased entries", async () => {
		const root = await createTemporaryRoot();
		const bundlePath = join(root, "state");
		await mkdir(bundlePath);
		await writeFile(join(bundlePath, "MANIFEST.json"), createManifest("Valid."));
		await writeFile(join(bundlePath, "EVOLVE.md"), "Valid.");
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/exactly manifest\.json and EVOLVE\.md/i);
	});

	test.each(["manifest.json", "EVOLVE.md"] as const)("rejects a linked %s entry", async (linkedName) => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root);
		await rm(join(bundlePath, linkedName));
		const linkTarget = join(root, `${linkedName}-target`);
		await mkdir(linkTarget);
		await symlink(linkTarget, join(bundlePath, linkedName), process.platform === "win32" ? "junction" : "dir");
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/direct regular file/i);
	});

	test.each(["manifest.json", "EVOLVE.md"] as const)("rejects a non-regular %s entry", async (entryName) => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root);
		await rm(join(bundlePath, entryName));
		await mkdir(join(bundlePath, entryName));
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/direct regular file/i);
	});
});

describe("bundle data validation", () => {
	test.each(["manifest.json", "EVOLVE.md"] as const)("rejects malformed UTF-8 in %s", async (entryName) => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root);
		await writeFile(join(bundlePath, entryName), new Uint8Array([0xc3, 0x28]));
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(new RegExp(entryName.replace(".", "\\."), "i"));
	});

	test.each(["manifest.json", "EVOLVE.md"] as const)("rejects a UTF-8 BOM in %s", async (entryName) => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root);
		const validContent = entryName === "manifest.json" ? createManifest("Act carefully.\n") : "Valid prompt.";
		await writeFile(
			join(bundlePath, entryName),
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validContent)]),
		);
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/BOM/i);
	});

	test("wraps malformed manifest JSON with its path and syntax error cause", async () => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root, "state", "{not-json}\n");
		const manifestPath = join(bundlePath, "manifest.json");
		let thrown: unknown;
		try {
			await loadHarnessState(bundlePath);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain(manifestPath);
		expect((thrown as Error).cause).toBeInstanceOf(SyntaxError);
	});

	test.each([
		["wrong algorithm", '{"contentHash":"sha1:0123456789abcdef0123456789abcdef01234567"}\n'],
		["unknown field", `${createManifest("Act carefully.\n").trimEnd().slice(0, -1)},"extra":true}\n`],
		["missing content hash", "{}\n"],
		["non-object", "[]\n"],
	] as const)("rejects a manifest with %s", async (_label, manifest) => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root, "state", manifest);
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/manifest/i);
	});

	test.each([
		["blank", ""],
		["whitespace-only", " \t\r\n"],
		["leading U+FEFF", "\uFEFFPrompt."],
	] as const)("rejects a %s prompt", async (_label, prompt) => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root, "state", createManifest(String(prompt)), prompt);
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/EVOLVE\.md/i);
	});

	test("rejects prompt content that does not match the manifest hash", async () => {
		const root = await createTemporaryRoot();
		const bundlePath = await createBundle(root, "state", createManifest("Original."), "Changed.");
		await expect(loadHarnessState(bundlePath)).rejects.toThrow(/content hash mismatch/i);
	});
});
