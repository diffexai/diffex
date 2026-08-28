import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import lockfile from "proper-lockfile";
import Type from "typebox";
import { Check } from "typebox/value";
import { parse } from "yaml";

const SHA256_PATTERN = "^sha256:[0-9a-f]{64}$";
const VERSION_DIRECTORY_PATTERN = /^sha256-([0-9a-f]{64})$/;
const EVOLUTION_MEMORY_NAME = "EVOLVE.md";
const MANIFEST_NAME = "manifest.json";
const CURRENT_NAME = "current.json";
const STORE_DIRECTORY_NAME = "harness-state";
const VERSIONS_DIRECTORY_NAME = "versions";
const LOCK_NAME = ".harness-state.lock";
const LOCK_STALE_AFTER_MS = 30_000;
const EVOLUTION_MEMORY_ARTIFACT_KIND = "evolution-memory";
const SKILL_ARTIFACT_KIND = "skill";
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

export const HARNESS_VERSION_SCHEMA_VERSION = 2 as const;

export const HarnessVersionSchema = Type.Readonly(Type.String({ pattern: SHA256_PATTERN }));
export type HarnessVersion = string;

const NonEmptyEvolutionMemorySchema = Type.String({
	pattern: "^(?!\\uFEFF)(?=[\\s\\S]*\\S)(?![\\s\\S]*[\\uD800-\\uDFFF])[\\s\\S]+$",
});
const EvolutionMemorySchema = Type.Union([Type.Literal(""), NonEmptyEvolutionMemorySchema]);
const SkillContentSchema = Type.String({
	pattern: "^(?!\\uFEFF)(?![\\s\\S]*[\\uD800-\\uDFFF])[\\s\\S]+$",
});
export const HarnessWorkspaceIdentitySchema = Type.Readonly(
	Type.Object(
		{
			repositoryId: Type.String({ minLength: 1 }),
			directoryId: Type.Optional(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	),
);
export interface HarnessWorkspaceIdentity {
	readonly repositoryId: string;
	readonly directoryId?: string;
}

export function computeHarnessSkillId(workspace: HarnessWorkspaceIdentity, path: string): string {
	validateArtifactPath(path);
	return `skill:${createHash("sha256")
		.update(JSON.stringify(["evolved", workspace.repositoryId, workspace.directoryId ?? null, path]))
		.digest("hex")}`;
}

export const HarnessSkillInputSchema = Type.Readonly(
	Type.Object(
		{
			path: Type.String({ minLength: 1 }),
			content: SkillContentSchema,
			workspace: HarnessWorkspaceIdentitySchema,
		},
		{ additionalProperties: false },
	),
);
export interface HarnessSkillInput {
	readonly path: string;
	readonly content: string;
	readonly workspace: HarnessWorkspaceIdentity;
}

export const HarnessSkillSchema = Type.Readonly(
	Type.Object(
		{
			path: Type.String({ minLength: 1 }),
			filePath: Type.String({ minLength: 1 }),
			baseDir: Type.String({ minLength: 1 }),
			name: Type.String({ minLength: 1 }),
			description: Type.String({ minLength: 1 }),
			content: SkillContentSchema,
			contentHash: HarnessVersionSchema,
			workspace: HarnessWorkspaceIdentitySchema,
			disableModelInvocation: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
);
export interface HarnessSkill {
	readonly path: string;
	readonly filePath: string;
	readonly baseDir: string;
	readonly name: string;
	readonly description: string;
	readonly content: string;
	readonly contentHash: HarnessVersion;
	readonly workspace: HarnessWorkspaceIdentity;
	readonly disableModelInvocation: boolean;
}

export const HarnessStateSchema = Type.Readonly(
	Type.Object(
		{
			memory: EvolutionMemorySchema,
			skills: Type.Readonly(Type.Array(HarnessSkillSchema)),
		},
		{ additionalProperties: false },
	),
);
export interface HarnessState {
	readonly memory: string;
	readonly skills: readonly HarnessSkill[];
}

export const HarnessStateInputSchema = Type.Readonly(
	Type.Object(
		{
			memory: EvolutionMemorySchema,
			skills: Type.Optional(Type.Readonly(Type.Array(HarnessSkillInputSchema))),
		},
		{ additionalProperties: false },
	),
);
export interface HarnessStateInput {
	readonly memory: string;
	readonly skills?: readonly HarnessSkillInput[];
}

export const HarnessVersionMetadataSchema = Type.Readonly(
	Type.Object(
		{
			evolutionMemory: Type.Readonly(
				Type.Object({ nextLessonNumber: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
			),
		},
		{ additionalProperties: false },
	),
);
export interface HarnessVersionMetadata {
	readonly evolutionMemory: {
		readonly nextLessonNumber: number;
	};
}
export const INITIAL_HARNESS_VERSION_METADATA: HarnessVersionMetadata = {
	evolutionMemory: { nextLessonNumber: 1 },
};

export const HarnessArtifactManifestSchema = Type.Readonly(
	Type.Object(
		{
			kind: Type.String({ minLength: 1 }),
			path: Type.String({ minLength: 1 }),
			contentHash: HarnessVersionSchema,
			workspace: Type.Optional(HarnessWorkspaceIdentitySchema),
		},
		{ additionalProperties: false },
	),
);
export interface HarnessArtifactManifest {
	readonly kind: string;
	readonly path: string;
	readonly contentHash: HarnessVersion;
	readonly workspace?: HarnessWorkspaceIdentity;
}

export const HarnessVersionManifestSchema = Type.Readonly(
	Type.Object(
		{
			schemaVersion: Type.Literal(HARNESS_VERSION_SCHEMA_VERSION),
			version: HarnessVersionSchema,
			base: Type.Union([Type.Null(), HarnessVersionSchema]),
			metadata: HarnessVersionMetadataSchema,
			artifacts: Type.Readonly(Type.Array(HarnessArtifactManifestSchema)),
		},
		{ additionalProperties: false },
	),
);
export interface HarnessVersionManifest {
	readonly schemaVersion: typeof HARNESS_VERSION_SCHEMA_VERSION;
	readonly version: HarnessVersion;
	readonly base: HarnessVersion | null;
	readonly metadata: HarnessVersionMetadata;
	readonly artifacts: readonly HarnessArtifactManifest[];
}

export const HarnessVersionPointerSchema = Type.Readonly(
	Type.Object({ version: HarnessVersionSchema }, { additionalProperties: false }),
);
export interface HarnessVersionPointer {
	readonly version: HarnessVersion;
}

export const HarnessVersionBundleSchema = Type.Readonly(
	Type.Object(
		{
			state: HarnessStateSchema,
			manifest: HarnessVersionManifestSchema,
		},
		{ additionalProperties: false },
	),
);
export interface HarnessVersionBundle {
	readonly state: HarnessState;
	readonly manifest: HarnessVersionManifest;
}

export interface HarnessVersionDiagnostic {
	readonly path: string;
	readonly version: HarnessVersion | null;
	readonly message: string;
	readonly manifest: HarnessVersionManifest | null;
	readonly state: HarnessState | null;
}

export interface HarnessVersionList {
	readonly versions: readonly HarnessVersionBundle[];
	readonly diagnostics: readonly HarnessVersionDiagnostic[];
	readonly currentVersion: HarnessVersion | null;
}

export interface HarnessAdvanceSuccess {
	readonly status: "advanced";
	readonly bundle: HarnessVersionBundle;
}

export interface HarnessAdvanceConflict {
	readonly status: "conflict";
	readonly expectedBase: HarnessVersion;
	readonly actualBase: HarnessVersion;
}

export type HarnessAdvanceResult = HarnessAdvanceSuccess | HarnessAdvanceConflict;

export interface HarnessSelectSuccess {
	readonly status: "selected";
	readonly bundle: HarnessVersionBundle;
}

export interface HarnessSelectConflict {
	readonly status: "conflict";
	readonly expectedCurrent: HarnessVersion;
	readonly actualCurrent: HarnessVersion;
}

export type HarnessSelectResult = HarnessSelectSuccess | HarnessSelectConflict;

export interface HarnessVersionInput {
	readonly schemaVersion: typeof HARNESS_VERSION_SCHEMA_VERSION;
	readonly base: HarnessVersion | null;
	readonly metadata: HarnessVersionMetadata;
	readonly artifacts: readonly HarnessArtifactManifest[];
}

function computeContentHash(bytes: Uint8Array): HarnessVersion {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function compareArtifacts(left: HarnessArtifactManifest, right: HarnessArtifactManifest): number {
	return (
		compareText(left.kind, right.kind) ||
		compareText(left.path, right.path) ||
		compareText(left.contentHash, right.contentHash) ||
		compareText(left.workspace?.repositoryId ?? "", right.workspace?.repositoryId ?? "") ||
		compareText(left.workspace?.directoryId ?? "", right.workspace?.directoryId ?? "")
	);
}

function canonicalArtifact(artifact: HarnessArtifactManifest): HarnessArtifactManifest {
	return {
		kind: artifact.kind,
		path: artifact.path,
		contentHash: artifact.contentHash,
		...(artifact.workspace === undefined
			? {}
			: {
					workspace: {
						repositoryId: artifact.workspace.repositoryId,
						...(artifact.workspace.directoryId === undefined
							? {}
							: { directoryId: artifact.workspace.directoryId }),
					},
				}),
	};
}

export function serializeHarnessVersion(input: HarnessVersionInput): string {
	if (
		input.schemaVersion !== HARNESS_VERSION_SCHEMA_VERSION ||
		!Check(Type.Union([Type.Null(), HarnessVersionSchema]), input.base)
	) {
		throw new Error("Invalid harness version input");
	}
	if (
		!Array.isArray(input.artifacts) ||
		input.artifacts.some((artifact) => !Check(HarnessArtifactManifestSchema, artifact))
	) {
		throw new Error("Invalid harness version artifacts");
	}
	if (!Check(HarnessVersionMetadataSchema, input.metadata)) {
		throw new Error("Invalid harness version metadata");
	}
	const artifacts = [...input.artifacts].sort(compareArtifacts).map(canonicalArtifact);
	return JSON.stringify({
		schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
		base: input.base,
		metadata: input.metadata,
		artifacts,
	});
}

export function computeHarnessVersion(input: HarnessVersionInput): HarnessVersion {
	return computeContentHash(UTF8_ENCODER.encode(serializeHarnessVersion(input)));
}

export function harnessVersionDirectoryName(version: HarnessVersion): string {
	if (!Check(HarnessVersionSchema, version)) throw new Error(`Invalid harness version "${version}"`);
	return version.replace("sha256:", "sha256-");
}

function versionFromDirectoryName(name: string): HarnessVersion | null {
	const match = VERSION_DIRECTORY_PATTERN.exec(name);
	return match === null ? null : `sha256:${match[1]}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
}

function decodeUtf8(bytes: Uint8Array, filePath: string): string {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw new Error(`Harness state file "${filePath}" must not start with a UTF-8 BOM`);
	}
	try {
		return UTF8_DECODER.decode(bytes);
	} catch (cause) {
		throw new Error(`Invalid UTF-8 in harness state file "${filePath}"`, { cause });
	}
}

function parseJson(value: string, filePath: string): unknown {
	try {
		return JSON.parse(value);
	} catch (cause) {
		throw new Error(`Invalid JSON in harness state file "${filePath}"`, { cause });
	}
}

function parseManifest(bytes: Uint8Array, manifestPath: string): HarnessVersionManifest {
	const parsed = parseJson(decodeUtf8(bytes, manifestPath), manifestPath);
	if (!Check(HarnessVersionManifestSchema, parsed)) {
		throw new Error(`Invalid harness version manifest at "${manifestPath}"`);
	}
	return parsed as HarnessVersionManifest;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HarnessSkillContentMetadata {
	readonly name: string;
	readonly description: string;
	readonly disableModelInvocation: boolean;
}

function parseSkillFrontmatter(content: string, artifactPath: string): HarnessSkillContentMetadata {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
	if (match === null) throw new Error(`Harness skill "${artifactPath}" must start with YAML frontmatter`);
	let parsed: unknown;
	try {
		parsed = parse(match[1] ?? "");
	} catch (cause) {
		throw new Error(`Harness skill "${artifactPath}" has invalid YAML frontmatter`, { cause });
	}
	if (!isRecord(parsed)) throw new Error(`Harness skill "${artifactPath}" frontmatter must be a mapping`);
	const name = parsed.name;
	const description = parsed.description;
	const disableModelInvocation = parsed["disable-model-invocation"];
	if (typeof name !== "string" || name.length > MAX_SKILL_NAME_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		throw new Error(`Harness skill "${artifactPath}" has an invalid name`);
	}
	if (
		typeof description !== "string" ||
		description.trim() === "" ||
		description.length > MAX_SKILL_DESCRIPTION_LENGTH
	) {
		throw new Error(`Harness skill "${artifactPath}" has an invalid description`);
	}
	if (disableModelInvocation !== undefined && typeof disableModelInvocation !== "boolean") {
		throw new Error(`Harness skill "${artifactPath}" has an invalid disable-model-invocation value`);
	}
	return { name, description, disableModelInvocation: disableModelInvocation === true };
}

function validateArtifactPath(path: string): void {
	const segments = path.split("/");
	if (
		path === "" ||
		path.startsWith("/") ||
		path.startsWith("\\") ||
		path.includes("\\") ||
		/^[A-Za-z]:/.test(path) ||
		segments.some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new Error(`Invalid harness artifact path "${path}"`);
	}
	for (const segment of segments) {
		if (
			/[<>:"|?*\u0000-\u001f]/.test(segment) ||
			/[. ]$/.test(segment) ||
			/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
		) {
			throw new Error(`Harness artifact path "${path}" is not portable across supported platforms`);
		}
	}
}

export function validateHarnessSkillContent(path: string, content: string): HarnessSkillContentMetadata {
	if (!Check(SkillContentSchema, content)) throw new Error(`Harness skill "${path}" has invalid content`);
	validateArtifactPath(path);
	const frontmatter = parseSkillFrontmatter(content, path);
	if (path !== `skills/${frontmatter.name}/SKILL.md`) {
		throw new Error(`Harness skill "${path}" name does not match its canonical path`);
	}
	return frontmatter;
}

async function inspectBundleRoot(bundlePath: string): Promise<void> {
	const stats = await lstat(bundlePath);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Harness version bundle "${bundlePath}" must be a direct directory`);
	}
}

interface BundleInventory {
	readonly files: readonly string[];
	readonly directories: readonly string[];
}

async function collectBundleInventory(bundlePath: string, relativeDirectory = ""): Promise<BundleInventory> {
	const directoryPath = relativeDirectory === "" ? bundlePath : join(bundlePath, ...relativeDirectory.split("/"));
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const files: string[] = [];
	const directories: string[] = [];
	for (const entry of entries) {
		const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
		const entryPath = join(directoryPath, entry.name);
		const entryStats = await lstat(entryPath);
		if (entryStats.isSymbolicLink()) {
			throw new Error(`Harness version bundle entry "${entryPath}" must not be a symbolic link`);
		}
		if (entryStats.isDirectory()) {
			directories.push(relativePath);
			const nested = await collectBundleInventory(bundlePath, relativePath);
			files.push(...nested.files);
			directories.push(...nested.directories);
			continue;
		}
		if (!entryStats.isFile()) {
			throw new Error(`Harness version bundle entry "${entryPath}" must be a regular file`);
		}
		files.push(relativePath);
	}
	return { files, directories };
}

function validateManifestInventory(manifest: HarnessVersionManifest): void {
	const paths = new Set<string>();
	const portablePaths = new Set<string>();
	for (const artifact of manifest.artifacts) {
		validateArtifactPath(artifact.path);
		if (artifact.path === MANIFEST_NAME) {
			throw new Error(`Harness artifact path "${artifact.path}" is reserved`);
		}
		if (paths.has(artifact.path)) throw new Error(`Duplicate harness artifact path "${artifact.path}"`);
		const portablePath = artifact.path.normalize("NFC").toLowerCase();
		if (portablePaths.has(portablePath)) {
			throw new Error(`Harness artifact path "${artifact.path}" collides on a case-insensitive filesystem`);
		}
		paths.add(artifact.path);
		portablePaths.add(portablePath);
	}
	const computedVersion = computeHarnessVersion(manifest);
	if (computedVersion !== manifest.version) {
		throw new Error(`Harness version hash mismatch: declared ${manifest.version}, computed ${computedVersion}`);
	}
}

interface SupportedArtifactInventory {
	readonly memory: HarnessArtifactManifest;
	readonly skills: readonly HarnessArtifactManifest[];
}

function validateSupportedArtifacts(manifest: HarnessVersionManifest): SupportedArtifactInventory {
	const memoryArtifacts = manifest.artifacts.filter((artifact) => artifact.kind === EVOLUTION_MEMORY_ARTIFACT_KIND);
	const skillArtifacts = manifest.artifacts.filter((artifact) => artifact.kind === SKILL_ARTIFACT_KIND);
	const unsupported = manifest.artifacts.find(
		(artifact) => artifact.kind !== EVOLUTION_MEMORY_ARTIFACT_KIND && artifact.kind !== SKILL_ARTIFACT_KIND,
	);
	if (unsupported !== undefined) {
		throw new Error(`Unsupported harness artifact kind "${unsupported.kind}"`);
	}
	if (
		memoryArtifacts.length !== 1 ||
		memoryArtifacts[0]?.path !== EVOLUTION_MEMORY_NAME ||
		memoryArtifacts[0]?.workspace !== undefined
	) {
		throw new Error(
			`Harness version must declare exactly one ${EVOLUTION_MEMORY_ARTIFACT_KIND} artifact at EVOLVE.md`,
		);
	}
	for (const artifact of skillArtifacts) {
		if (artifact.workspace === undefined || !/^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/.test(artifact.path)) {
			throw new Error(`Harness skill artifact "${artifact.path}" must have a canonical path and workspace identity`);
		}
	}
	return { memory: memoryArtifacts[0] as HarnessArtifactManifest, skills: skillArtifacts };
}

export async function loadHarnessState(bundlePath: string): Promise<HarnessVersionBundle> {
	await inspectBundleRoot(bundlePath);
	const manifestPath = join(bundlePath, MANIFEST_NAME);
	const manifestStats = await lstat(manifestPath);
	if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
		throw new Error(`Harness version manifest "${manifestPath}" must be a direct regular file`);
	}
	const manifest = parseManifest(await readFile(manifestPath), manifestPath);
	validateManifestInventory(manifest);

	const inventory = await collectBundleInventory(bundlePath);
	const files = [...inventory.files].sort(compareText);
	const declaredFiles = [MANIFEST_NAME, ...manifest.artifacts.map((artifact) => artifact.path)].sort(compareText);
	const declaredDirectories = new Set(
		manifest.artifacts.flatMap((artifact) => {
			const segments = artifact.path.split("/");
			return segments.slice(0, -1).map((_segment, index) => segments.slice(0, index + 1).join("/"));
		}),
	);
	if (files.length !== declaredFiles.length || files.some((file, index) => file !== declaredFiles[index])) {
		const undeclared = files.filter((file) => !declaredFiles.includes(file));
		const missing = declaredFiles.filter((file) => !files.includes(file));
		const details = [
			undeclared.length === 0 ? "" : ` undeclared: ${undeclared.join(", ")};`,
			missing.length === 0 ? "" : ` missing: ${missing.join(", ")};`,
		]
			.join("")
			.trim();
		throw new Error(`Harness version inventory mismatch at "${bundlePath}"${details === "" ? "" : ` (${details})`}`);
	}
	const undeclaredDirectories = inventory.directories.filter((path) => !declaredDirectories.has(path));
	if (undeclaredDirectories.length > 0) {
		throw new Error(
			`Harness version inventory mismatch at "${bundlePath}" (undeclared directories: ${undeclaredDirectories.join(", ")})`,
		);
	}

	const artifactBytes = new Map<string, Uint8Array>();
	for (const artifact of manifest.artifacts) {
		const artifactPath = join(bundlePath, ...artifact.path.split("/"));
		const artifactStats = await lstat(artifactPath);
		if (!artifactStats.isFile() || artifactStats.isSymbolicLink()) {
			throw new Error(`Harness artifact "${artifactPath}" must be a direct regular file`);
		}
		const bytes = await readFile(artifactPath);
		if (computeContentHash(bytes) !== artifact.contentHash) {
			throw new Error(`Harness artifact content hash mismatch at "${artifactPath}"`);
		}
		artifactBytes.set(artifact.path, bytes);
	}

	const supported = validateSupportedArtifacts(manifest);
	const memoryPath = join(bundlePath, EVOLUTION_MEMORY_NAME);
	const memoryBytes = artifactBytes.get(supported.memory.path);
	if (memoryBytes === undefined) throw new Error(`Harness evolution memory is missing at "${memoryPath}"`);
	const memory = decodeUtf8(memoryBytes, memoryPath);
	const skills: HarnessSkill[] = [];
	const skillNames = new Set<string>();
	for (const artifact of supported.skills) {
		const artifactPath = join(bundlePath, ...artifact.path.split("/"));
		const bytes = artifactBytes.get(artifact.path);
		if (bytes === undefined) throw new Error(`Harness skill is missing at "${artifactPath}"`);
		const content = decodeUtf8(bytes, artifactPath);
		const frontmatter = validateHarnessSkillContent(artifact.path, content);
		if (skillNames.has(frontmatter.name)) {
			throw new Error(`Harness skill name collision for "${frontmatter.name}"`);
		}
		skillNames.add(frontmatter.name);
		skills.push({
			path: artifact.path,
			filePath: artifactPath,
			baseDir: dirname(artifactPath),
			name: frontmatter.name,
			description: frontmatter.description,
			content,
			contentHash: artifact.contentHash,
			workspace: artifact.workspace as HarnessWorkspaceIdentity,
			disableModelInvocation: frontmatter.disableModelInvocation,
		});
	}
	if (!Check(EvolutionMemorySchema, memory)) {
		throw new Error(`Invalid harness evolution memory at "${memoryPath}"`);
	}
	const state = { memory, skills };
	if (!Check(HarnessStateSchema, state)) throw new Error(`Invalid harness state at "${bundlePath}"`);
	return { state, manifest };
}

async function assertDirectoryParent(destinationPath: string): Promise<void> {
	const parentPath = dirname(destinationPath);
	const parentStats = await stat(parentPath);
	if (!parentStats.isDirectory()) {
		throw new Error(`Harness version destination parent "${parentPath}" must be a directory`);
	}
}

function bundlesMatch(left: HarnessVersionBundle, right: HarnessVersionBundle): boolean {
	return left.manifest.version === right.manifest.version;
}

async function loadIdempotentDestination(
	destinationPath: string,
	expected: HarnessVersionBundle,
): Promise<HarnessVersionBundle> {
	const existing = await loadHarnessState(destinationPath);
	if (!bundlesMatch(existing, expected)) {
		throw new Error(`Immutable harness version destination "${destinationPath}" has different content`);
	}
	return existing;
}

async function inspectIncompatibleBundle(bundlePath: string): Promise<{
	readonly manifest: HarnessVersionManifest;
	readonly state: HarnessState | null;
}> {
	const manifestPath = join(bundlePath, MANIFEST_NAME);
	const manifest = parseManifest(await readFile(manifestPath), manifestPath);
	validateManifestInventory(manifest);
	const evolutionArtifacts = manifest.artifacts.filter(
		(artifact) => artifact.kind === EVOLUTION_MEMORY_ARTIFACT_KIND && artifact.path === EVOLUTION_MEMORY_NAME,
	);
	if (evolutionArtifacts.length !== 1) return { manifest, state: null };
	const memoryPath = join(bundlePath, EVOLUTION_MEMORY_NAME);
	const memoryBytes = await readFile(memoryPath);
	if (computeContentHash(memoryBytes) !== evolutionArtifacts[0]?.contentHash) return { manifest, state: null };
	const state = { memory: decodeUtf8(memoryBytes, memoryPath), skills: [] };
	return { manifest, state: Check(HarnessStateSchema, state) ? state : null };
}

interface PreparedHarnessState {
	readonly state: HarnessState;
	readonly artifacts: readonly HarnessArtifactManifest[];
	readonly files: ReadonlyMap<string, Uint8Array>;
}

function prepareHarnessState(input: HarnessStateInput, bundlePath: string): PreparedHarnessState {
	const memoryBytes = UTF8_ENCODER.encode(input.memory);
	const memoryArtifact: HarnessArtifactManifest = {
		kind: EVOLUTION_MEMORY_ARTIFACT_KIND,
		path: EVOLUTION_MEMORY_NAME,
		contentHash: computeContentHash(memoryBytes),
	};
	const files = new Map<string, Uint8Array>([[EVOLUTION_MEMORY_NAME, memoryBytes]]);
	const skills: HarnessSkill[] = [];
	const skillArtifacts: HarnessArtifactManifest[] = [];
	const skillNames = new Set<string>();
	for (const inputSkill of [...(input.skills ?? [])].sort((left, right) => compareText(left.path, right.path))) {
		const frontmatter = validateHarnessSkillContent(inputSkill.path, inputSkill.content);
		const contentBytes = UTF8_ENCODER.encode(inputSkill.content);
		if (skillNames.has(frontmatter.name)) {
			throw new Error(`Harness skill name collision for "${frontmatter.name}"`);
		}
		skillNames.add(frontmatter.name);
		const filePath = join(bundlePath, ...inputSkill.path.split("/"));
		const contentHash = computeContentHash(contentBytes);
		const workspace: HarnessWorkspaceIdentity = {
			repositoryId: inputSkill.workspace.repositoryId,
			...(inputSkill.workspace.directoryId === undefined ? {} : { directoryId: inputSkill.workspace.directoryId }),
		};
		skills.push({
			path: inputSkill.path,
			filePath,
			baseDir: dirname(filePath),
			name: frontmatter.name,
			description: frontmatter.description,
			content: inputSkill.content,
			contentHash,
			workspace,
			disableModelInvocation: frontmatter.disableModelInvocation,
		});
		skillArtifacts.push({
			kind: SKILL_ARTIFACT_KIND,
			path: inputSkill.path,
			contentHash,
			workspace,
		});
		files.set(inputSkill.path, contentBytes);
	}
	const artifacts = [memoryArtifact, ...skillArtifacts].sort(compareArtifacts);
	return { state: { memory: input.memory, skills }, artifacts, files };
}

export async function saveHarnessState(
	state: unknown,
	destinationPath: string,
	base: HarnessVersion | null,
	metadata: HarnessVersionMetadata,
): Promise<HarnessVersionBundle> {
	if (!Check(HarnessStateInputSchema, state)) throw new Error("Invalid harness state to save");
	if (!Check(Type.Union([Type.Null(), HarnessVersionSchema]), base)) throw new Error("Invalid harness base version");
	if (!Check(HarnessVersionMetadataSchema, metadata)) {
		throw new Error("Invalid harness version metadata");
	}
	const absoluteDestinationPath = resolve(destinationPath);
	const prepared = prepareHarnessState(state as HarnessStateInput, absoluteDestinationPath);
	const versionInput = {
		schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
		base,
		metadata,
		artifacts: prepared.artifacts,
	};
	const version = computeHarnessVersion(versionInput);
	const manifest: HarnessVersionManifest = {
		schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
		version,
		base,
		metadata,
		artifacts: prepared.artifacts,
	};
	const bundle: HarnessVersionBundle = { state: prepared.state, manifest };
	await assertDirectoryParent(absoluteDestinationPath);
	if (await pathExists(absoluteDestinationPath)) return loadIdempotentDestination(absoluteDestinationPath, bundle);

	let temporaryPath: string | undefined;
	try {
		temporaryPath = await mkdtemp(
			join(dirname(absoluteDestinationPath), `.${basename(absoluteDestinationPath)}.tmp-`),
		);
		await writeFile(join(temporaryPath, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		for (const [path, bytes] of prepared.files) {
			const filePath = join(temporaryPath, ...path.split("/"));
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, bytes, { flag: "wx" });
		}
		try {
			await rename(temporaryPath, absoluteDestinationPath);
			temporaryPath = undefined;
		} catch (error) {
			if (!(await pathExists(absoluteDestinationPath))) throw error;
			const existing = await loadIdempotentDestination(absoluteDestinationPath, bundle);
			if (temporaryPath !== undefined) await rm(temporaryPath, { recursive: true, force: true });
			temporaryPath = undefined;
			return existing;
		}
	} catch (error) {
		if (temporaryPath !== undefined) {
			try {
				await rm(temporaryPath, { recursive: true, force: true });
			} catch {}
		}
		throw error;
	}
	return bundle;
}

export class HarnessStateStore {
	readonly #agentDir: string;
	readonly #storePath: string;
	readonly #versionsPath: string;
	readonly #currentPath: string;
	readonly #lockPath: string;

	constructor(agentDir: string) {
		this.#agentDir = resolve(agentDir);
		this.#storePath = join(this.#agentDir, STORE_DIRECTORY_NAME);
		this.#versionsPath = join(this.#storePath, VERSIONS_DIRECTORY_NAME);
		this.#currentPath = join(this.#storePath, CURRENT_NAME);
		this.#lockPath = join(this.#agentDir, LOCK_NAME);
	}

	async #ensureDirectories(): Promise<void> {
		await mkdir(this.#agentDir, { recursive: true });
		await mkdir(this.#storePath, { recursive: true });
		const storeStats = await lstat(this.#storePath);
		if (!storeStats.isDirectory() || storeStats.isSymbolicLink()) {
			throw new Error(`Harness state path "${this.#storePath}" must be a direct directory`);
		}
		await mkdir(this.#versionsPath, { recursive: true });
		const versionsStats = await lstat(this.#versionsPath);
		if (!versionsStats.isDirectory() || versionsStats.isSymbolicLink()) {
			throw new Error(`Harness state path "${this.#versionsPath}" must be a direct directory`);
		}
	}

	async #withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.#agentDir, { recursive: true });
		const release = await lockfile.lock(this.#agentDir, {
			lockfilePath: this.#lockPath,
			realpath: false,
			stale: LOCK_STALE_AFTER_MS,
			update: 10_000,
			retries: {
				retries: 2_000,
				factor: 1,
				minTimeout: 10,
				maxTimeout: 25,
				randomize: true,
			},
		});
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	#versionPath(version: HarnessVersion): string {
		return join(this.#versionsPath, harnessVersionDirectoryName(version));
	}

	async #loadVersion(version: HarnessVersion): Promise<HarnessVersionBundle> {
		if (!Check(HarnessVersionSchema, version)) throw new Error(`Invalid harness version "${version}"`);
		const bundlePath = this.#versionPath(version);
		const bundle = await loadHarnessState(bundlePath);
		if (bundle.manifest.version !== version) {
			throw new Error(`Harness version directory "${bundlePath}" contains ${bundle.manifest.version}`);
		}
		return bundle;
	}

	async #loadPointer(): Promise<HarnessVersionPointer> {
		const pointerStats = await lstat(this.#currentPath);
		if (!pointerStats.isFile() || pointerStats.isSymbolicLink()) {
			throw new Error(`Harness version pointer "${this.#currentPath}" must be a direct regular file`);
		}
		const parsed = parseJson(decodeUtf8(await readFile(this.#currentPath), this.#currentPath), this.#currentPath);
		if (!Check(HarnessVersionPointerSchema, parsed)) {
			throw new Error(`Invalid harness version pointer at "${this.#currentPath}"`);
		}
		return parsed as HarnessVersionPointer;
	}

	async #replacePointer(version: HarnessVersion): Promise<void> {
		const temporaryPath = join(this.#storePath, `.${CURRENT_NAME}.${randomUUID()}.tmp`);
		let displacedDirectoryPath: string | undefined;
		try {
			await writeFile(temporaryPath, `${JSON.stringify({ version }, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			if (await pathExists(this.#currentPath)) {
				const currentStats = await lstat(this.#currentPath);
				if (currentStats.isDirectory() && !currentStats.isSymbolicLink()) {
					displacedDirectoryPath = join(this.#storePath, `.${CURRENT_NAME}.${randomUUID()}.invalid`);
					await rename(this.#currentPath, displacedDirectoryPath);
				}
			}
			await rename(temporaryPath, this.#currentPath);
			if (displacedDirectoryPath !== undefined) {
				await rm(displacedDirectoryPath, { recursive: true, force: true });
				displacedDirectoryPath = undefined;
			}
		} catch (error) {
			try {
				await unlink(temporaryPath);
			} catch (cleanupError) {
				if (!hasErrorCode(cleanupError, "ENOENT")) throw cleanupError;
			}
			if (displacedDirectoryPath !== undefined && !(await pathExists(this.#currentPath))) {
				await rename(displacedDirectoryPath, this.#currentPath);
			}
			throw error;
		}
	}

	async initialize(): Promise<HarnessVersionBundle> {
		return this.#withLock(async () => {
			await this.#ensureDirectories();
			if (await pathExists(this.#currentPath)) {
				const pointer = await this.#loadPointer();
				return this.#loadVersion(pointer.version);
			}
			const root = await this.saveVersion({ memory: "" }, null, INITIAL_HARNESS_VERSION_METADATA);
			await this.#replacePointer(root.manifest.version);
			return root;
		});
	}

	async loadCurrent(): Promise<HarnessVersionBundle> {
		const pointer = await this.#loadPointer();
		return this.#loadVersion(pointer.version);
	}

	loadVersion(version: HarnessVersion): Promise<HarnessVersionBundle> {
		return this.#loadVersion(version);
	}

	async listVersions(): Promise<HarnessVersionList> {
		let entries: Dirent[];
		try {
			entries = await readdir(this.#versionsPath, { withFileTypes: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) entries = [];
			else throw error;
		}
		const versions: HarnessVersionBundle[] = [];
		const diagnostics: HarnessVersionDiagnostic[] = [];
		for (const entry of [...entries].sort((left, right) => compareText(left.name, right.name))) {
			if (/^\.sha256-[0-9a-f]{64}\.tmp-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
			const path = join(this.#versionsPath, entry.name);
			const inferredVersion = versionFromDirectoryName(entry.name);
			try {
				if (!entry.isDirectory() || entry.isSymbolicLink()) {
					throw new Error(`Harness version path "${path}" must be a direct directory`);
				}
				if (inferredVersion === null) throw new Error(`Invalid harness version directory name "${entry.name}"`);
				versions.push(await this.#loadVersion(inferredVersion));
			} catch (error) {
				let incompatible: Awaited<ReturnType<typeof inspectIncompatibleBundle>> | null = null;
				if (error instanceof Error && error.message.startsWith("Unsupported harness artifact kind")) {
					try {
						incompatible = await inspectIncompatibleBundle(path);
					} catch {}
				}
				diagnostics.push({
					path,
					version: inferredVersion,
					message: error instanceof Error ? error.message : String(error),
					manifest: incompatible?.manifest ?? null,
					state: incompatible?.state ?? null,
				});
			}
		}
		versions.sort((left, right) => compareText(left.manifest.version, right.manifest.version));
		let currentVersion: HarnessVersion | null = null;
		if (await pathExists(this.#currentPath)) {
			try {
				const current = await this.#loadPointer();
				currentVersion = current.version;
				if (
					!versions.some((bundle) => bundle.manifest.version === current.version) &&
					!diagnostics.some((diagnostic) => diagnostic.version === current.version)
				) {
					diagnostics.push({
						path: this.#currentPath,
						version: current.version,
						message: `Selected harness version ${current.version} does not exist`,
						manifest: null,
						state: null,
					});
				}
			} catch (error) {
				diagnostics.push({
					path: this.#currentPath,
					version: null,
					message: error instanceof Error ? error.message : String(error),
					manifest: null,
					state: null,
				});
			}
		}
		return { versions, diagnostics, currentVersion };
	}

	async saveVersion(
		state: HarnessStateInput,
		base: HarnessVersion | null,
		metadata?: HarnessVersionMetadata,
	): Promise<HarnessVersionBundle> {
		await this.#ensureDirectories();
		if (!Check(HarnessStateInputSchema, state)) throw new Error("Invalid harness state to save");
		if (!Check(Type.Union([Type.Null(), HarnessVersionSchema]), base))
			throw new Error("Invalid harness base version");
		const baseBundle = base === null ? undefined : await this.#loadVersion(base);
		const inheritedMetadata = metadata ?? baseBundle?.manifest.metadata;
		if (inheritedMetadata === undefined) throw new Error("Root harness versions require metadata");
		const resolvedState: HarnessStateInput =
			state.skills !== undefined || baseBundle === undefined
				? state
				: {
						memory: state.memory,
						skills: baseBundle.state.skills.map((skill) => ({
							path: skill.path,
							content: skill.content,
							workspace: skill.workspace,
						})),
					};
		const prepared = prepareHarnessState(resolvedState, this.#versionsPath);
		const version = computeHarnessVersion({
			schemaVersion: HARNESS_VERSION_SCHEMA_VERSION,
			base,
			metadata: inheritedMetadata,
			artifacts: prepared.artifacts,
		});
		return saveHarnessState(resolvedState, this.#versionPath(version), base, inheritedMetadata);
	}

	async selectVersion(version: HarnessVersion): Promise<HarnessVersionBundle> {
		return this.#withLock(async () => {
			await this.#ensureDirectories();
			const bundle = await this.#loadVersion(version);
			let current: HarnessVersionPointer | null = null;
			if (await pathExists(this.#currentPath)) {
				try {
					current = await this.#loadPointer();
				} catch {}
			}
			if (current?.version !== version) await this.#replacePointer(version);
			return bundle;
		});
	}

	async selectVersionIfCurrent(
		version: HarnessVersion,
		expectedCurrent: HarnessVersion,
	): Promise<HarnessSelectResult> {
		return this.#withLock(async () => {
			await this.#ensureDirectories();
			if (!Check(HarnessVersionSchema, expectedCurrent)) throw new Error("Invalid expected current harness version");
			const current = await this.#loadPointer();
			if (current.version !== expectedCurrent) {
				return { status: "conflict", expectedCurrent, actualCurrent: current.version };
			}
			const bundle = await this.#loadVersion(version);
			if (current.version !== version) await this.#replacePointer(version);
			return { status: "selected", bundle };
		});
	}

	async advance(
		state: HarnessStateInput,
		expectedBase: HarnessVersion,
		metadata?: HarnessVersionMetadata,
	): Promise<HarnessAdvanceResult> {
		return this.#withLock(async () => {
			await this.#ensureDirectories();
			if (!Check(HarnessStateInputSchema, state)) throw new Error("Invalid harness state to advance");
			if (!Check(HarnessVersionSchema, expectedBase)) throw new Error("Invalid expected harness base version");
			const current = await this.#loadPointer();
			if (current.version !== expectedBase) {
				return { status: "conflict", expectedBase, actualBase: current.version };
			}
			const currentBundle = await this.#loadVersion(current.version);
			const bundle = await this.saveVersion(state, expectedBase, metadata ?? currentBundle.manifest.metadata);
			await this.#replacePointer(bundle.manifest.version);
			return { status: "advanced", bundle };
		});
	}
}
