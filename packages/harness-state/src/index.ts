import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import lockfile from "proper-lockfile";
import Type from "typebox";
import { Check } from "typebox/value";

const SHA256_PATTERN = "^sha256:[0-9a-f]{64}$";
const VERSION_DIRECTORY_PATTERN = /^sha256-([0-9a-f]{64})$/;
const EVOLUTION_MEMORY_NAME = "EVOLVE.md";
const MANIFEST_NAME = "manifest.json";
const CURRENT_NAME = "current.json";
const STORE_DIRECTORY_NAME = "harness-state";
const VERSIONS_DIRECTORY_NAME = "versions";
const LOCK_NAME = ".harness-state.lock";
const LOCK_STALE_AFTER_MS = 30_000;
const SUPPORTED_ARTIFACT_KIND = "evolution-memory";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

export const HarnessVersionSchema = Type.Readonly(Type.String({ pattern: SHA256_PATTERN }));
export type HarnessVersion = string;

const NonEmptyEvolutionMemorySchema = Type.String({ pattern: "^(?!\\uFEFF)(?=[\\s\\S]*\\S)[\\s\\S]+$" });
export const HarnessStateSchema = Type.Readonly(
	Type.Object(
		{ memory: Type.Union([Type.Literal(""), NonEmptyEvolutionMemorySchema]) },
		{ additionalProperties: false },
	),
);
export interface HarnessState {
	readonly memory: string;
}

export const HarnessArtifactManifestSchema = Type.Readonly(
	Type.Object(
		{
			kind: Type.String({ minLength: 1 }),
			path: Type.String({ minLength: 1 }),
			contentHash: HarnessVersionSchema,
		},
		{ additionalProperties: false },
	),
);
export interface HarnessArtifactManifest {
	readonly kind: string;
	readonly path: string;
	readonly contentHash: HarnessVersion;
}

export const HarnessVersionManifestSchema = Type.Readonly(
	Type.Object(
		{
			schemaVersion: Type.Literal(1),
			version: HarnessVersionSchema,
			base: Type.Union([Type.Null(), HarnessVersionSchema]),
			artifacts: Type.Readonly(Type.Array(HarnessArtifactManifestSchema)),
		},
		{ additionalProperties: false },
	),
);
export interface HarnessVersionManifest {
	readonly schemaVersion: 1;
	readonly version: HarnessVersion;
	readonly base: HarnessVersion | null;
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
	readonly schemaVersion: 1;
	readonly base: HarnessVersion | null;
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
		compareText(left.contentHash, right.contentHash)
	);
}

export function serializeHarnessVersion(input: HarnessVersionInput): string {
	if (input.schemaVersion !== 1 || !Check(Type.Union([Type.Null(), HarnessVersionSchema]), input.base)) {
		throw new Error("Invalid harness version input");
	}
	if (
		!Array.isArray(input.artifacts) ||
		input.artifacts.some((artifact) => !Check(HarnessArtifactManifestSchema, artifact))
	) {
		throw new Error("Invalid harness version artifacts");
	}
	const artifacts = [...input.artifacts].sort(compareArtifacts).map(({ kind, path, contentHash }) => ({
		kind,
		path,
		contentHash,
	}));
	return JSON.stringify({ schemaVersion: 1, base: input.base, artifacts });
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

function validateSupportedArtifacts(manifest: HarnessVersionManifest): void {
	const evolutionArtifacts = manifest.artifacts.filter((artifact) => artifact.kind === SUPPORTED_ARTIFACT_KIND);
	const unsupported = manifest.artifacts.find((artifact) => artifact.kind !== SUPPORTED_ARTIFACT_KIND);
	if (unsupported !== undefined) {
		throw new Error(`Unsupported harness artifact kind "${unsupported.kind}"`);
	}
	if (
		evolutionArtifacts.length !== 1 ||
		evolutionArtifacts[0]?.path !== EVOLUTION_MEMORY_NAME ||
		manifest.artifacts.length !== 1
	) {
		throw new Error(`Harness version must declare exactly one ${SUPPORTED_ARTIFACT_KIND} artifact at EVOLVE.md`);
	}
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
	}

	validateSupportedArtifacts(manifest);
	const memoryPath = join(bundlePath, EVOLUTION_MEMORY_NAME);
	const memory = decodeUtf8(await readFile(memoryPath), memoryPath);
	const state = { memory };
	if (!Check(HarnessStateSchema, state)) throw new Error(`Invalid harness evolution memory at "${memoryPath}"`);
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
	return left.manifest.version === right.manifest.version && left.state.memory === right.state.memory;
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
	const evolutionArtifacts = manifest.artifacts.filter(
		(artifact) => artifact.kind === SUPPORTED_ARTIFACT_KIND && artifact.path === EVOLUTION_MEMORY_NAME,
	);
	if (evolutionArtifacts.length !== 1) return { manifest, state: null };
	const memoryPath = join(bundlePath, EVOLUTION_MEMORY_NAME);
	const memoryBytes = await readFile(memoryPath);
	if (computeContentHash(memoryBytes) !== evolutionArtifacts[0]?.contentHash) return { manifest, state: null };
	const state = { memory: decodeUtf8(memoryBytes, memoryPath) };
	return { manifest, state: Check(HarnessStateSchema, state) ? state : null };
}

export async function saveHarnessState(
	state: unknown,
	destinationPath: string,
	base: HarnessVersion | null,
): Promise<HarnessVersionBundle> {
	if (!Check(HarnessStateSchema, state)) throw new Error("Invalid harness state to save");
	if (!Check(Type.Union([Type.Null(), HarnessVersionSchema]), base)) throw new Error("Invalid harness base version");
	const memoryBytes = UTF8_ENCODER.encode(state.memory);
	const artifact: HarnessArtifactManifest = {
		kind: SUPPORTED_ARTIFACT_KIND,
		path: EVOLUTION_MEMORY_NAME,
		contentHash: computeContentHash(memoryBytes),
	};
	const version = computeHarnessVersion({ schemaVersion: 1, base, artifacts: [artifact] });
	const manifest: HarnessVersionManifest = { schemaVersion: 1, version, base, artifacts: [artifact] };
	const bundle: HarnessVersionBundle = { state, manifest };
	const absoluteDestinationPath = resolve(destinationPath);
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
		await writeFile(join(temporaryPath, EVOLUTION_MEMORY_NAME), memoryBytes, { flag: "wx" });
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
			const root = await this.saveVersion({ memory: "" }, null);
			await this.#replacePointer(root.manifest.version);
			return root;
		});
	}

	async loadCurrent(): Promise<HarnessVersionBundle> {
		const pointer = await this.#loadPointer();
		return this.#loadVersion(pointer.version);
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

	async saveVersion(state: HarnessState, base: HarnessVersion | null): Promise<HarnessVersionBundle> {
		await this.#ensureDirectories();
		if (!Check(HarnessStateSchema, state)) throw new Error("Invalid harness state to save");
		if (!Check(Type.Union([Type.Null(), HarnessVersionSchema]), base))
			throw new Error("Invalid harness base version");
		const artifact: HarnessArtifactManifest = {
			kind: SUPPORTED_ARTIFACT_KIND,
			path: EVOLUTION_MEMORY_NAME,
			contentHash: computeContentHash(UTF8_ENCODER.encode(state.memory)),
		};
		const version = computeHarnessVersion({ schemaVersion: 1, base, artifacts: [artifact] });
		return saveHarnessState(state, this.#versionPath(version), base);
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

	async advance(state: HarnessState, expectedBase: HarnessVersion): Promise<HarnessAdvanceResult> {
		return this.#withLock(async () => {
			await this.#ensureDirectories();
			if (!Check(HarnessStateSchema, state)) throw new Error("Invalid harness state to advance");
			if (!Check(HarnessVersionSchema, expectedBase)) throw new Error("Invalid expected harness base version");
			const current = await this.#loadPointer();
			if (current.version !== expectedBase) {
				return { status: "conflict", expectedBase, actualBase: current.version };
			}
			await this.#loadVersion(current.version);
			const bundle = await this.saveVersion(state, expectedBase);
			await this.#replacePointer(bundle.manifest.version);
			return { status: "advanced", bundle };
		});
	}
}
