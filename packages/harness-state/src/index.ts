import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

const SystemPromptSchema = Type.Readonly(Type.String({ pattern: "^(?!\\uFEFF)(?=[\\s\\S]*\\S)[\\s\\S]*$" }));

export const HarnessStateSchema = Type.Object({ systemPrompt: SystemPromptSchema }, { additionalProperties: false });
export type HarnessState = Static<typeof HarnessStateSchema>;

export const HarnessStateManifestSchema = Type.Object(
	{ contentHash: Type.Readonly(Type.String({ pattern: "^sha256:[0-9a-f]{64}$" })) },
	{ additionalProperties: false },
);
export type HarnessStateManifest = Static<typeof HarnessStateManifestSchema>;

const MANIFEST_NAME = "manifest.json";
const PROMPT_NAME = "EVOLVE.md";
const BUNDLE_ENTRY_NAMES = [MANIFEST_NAME, PROMPT_NAME] as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

function computeContentHash(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeBundleFile(bytes: Uint8Array, filePath: string): string {
	let value: string;
	try {
		value = UTF8_DECODER.decode(bytes);
	} catch (cause) {
		throw new Error(`Invalid UTF-8 in harness state file "${filePath}"`, { cause });
	}
	if (value.startsWith("\uFEFF")) throw new Error(`Harness state file "${filePath}" must not start with a UTF-8 BOM`);
	return value;
}

function parseManifest(value: string, manifestPath: string): HarnessStateManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new Error(`Invalid JSON in harness state manifest "${manifestPath}"`, { cause });
	}
	if (!Check(HarnessStateManifestSchema, parsed)) {
		throw new Error(`Invalid harness state manifest at "${manifestPath}"`);
	}
	return parsed;
}

async function inspectBundleDirectory(bundlePath: string): Promise<void> {
	const bundleStats = await lstat(bundlePath);
	if (!bundleStats.isDirectory() || bundleStats.isSymbolicLink()) {
		throw new Error(`Harness state bundle "${bundlePath}" must be a direct directory`);
	}

	const entries = await readdir(bundlePath, { withFileTypes: true });
	const expectedNames = new Set<string>(BUNDLE_ENTRY_NAMES);
	if (entries.length !== BUNDLE_ENTRY_NAMES.length || entries.some((entry) => !expectedNames.has(entry.name))) {
		throw new Error(`Harness state bundle "${bundlePath}" must contain exactly manifest.json and EVOLVE.md`);
	}
	for (const name of BUNDLE_ENTRY_NAMES) {
		const entry = entries.find((candidate) => candidate.name === name);
		if (!entry?.isFile() || entry.isSymbolicLink()) {
			throw new Error(`Harness state bundle entry "${join(bundlePath, name)}" must be a direct regular file`);
		}
	}
}

export async function loadHarnessState(bundlePath: string): Promise<HarnessState> {
	await inspectBundleDirectory(bundlePath);
	const manifestPath = join(bundlePath, MANIFEST_NAME);
	const promptPath = join(bundlePath, PROMPT_NAME);
	const manifestText = decodeBundleFile(await readFile(manifestPath), manifestPath);
	const manifest = parseManifest(manifestText, manifestPath);
	const promptBytes = await readFile(promptPath);
	const systemPrompt = decodeBundleFile(promptBytes, promptPath);
	const state = { systemPrompt };
	if (!Check(HarnessStateSchema, state)) throw new Error(`Invalid harness state prompt at "${promptPath}"`);
	if (manifest.contentHash !== computeContentHash(promptBytes)) {
		throw new Error(`Harness state content hash mismatch at "${promptPath}"`);
	}
	return state;
}

async function assertDestinationAbsent(destinationPath: string): Promise<void> {
	try {
		await lstat(destinationPath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	throw new Error(`Harness state destination "${destinationPath}" already exists`);
}

export async function saveHarnessState(state: unknown, destinationPath: string): Promise<void> {
	if (!Check(HarnessStateSchema, state)) throw new Error("Invalid harness state to save");
	const systemPrompt = state.systemPrompt;
	const promptBytes = UTF8_ENCODER.encode(systemPrompt);
	const manifest = `${JSON.stringify({ contentHash: computeContentHash(promptBytes) })}\n`;
	const absoluteDestinationPath = resolve(destinationPath);
	const parentPath = dirname(absoluteDestinationPath);
	const parentStats = await stat(parentPath);
	if (!parentStats.isDirectory()) {
		throw new Error(`Harness state destination parent "${parentPath}" must be a directory`);
	}
	await assertDestinationAbsent(absoluteDestinationPath);

	let temporaryPath: string | undefined;
	try {
		temporaryPath = await mkdtemp(join(parentPath, `.${basename(absoluteDestinationPath)}.harness-state.tmp-`));
		await writeFile(join(temporaryPath, MANIFEST_NAME), manifest, "utf8");
		await writeFile(join(temporaryPath, PROMPT_NAME), promptBytes);
		await assertDestinationAbsent(absoluteDestinationPath);
		await rename(temporaryPath, absoluteDestinationPath);
		temporaryPath = undefined;
	} catch (error) {
		if (temporaryPath !== undefined) {
			try {
				await rm(temporaryPath, { recursive: true, force: true });
			} catch {}
		}
		throw error;
	}
}
