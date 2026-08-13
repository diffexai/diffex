import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { EvolvedNote } from "./evolved.ts";
import { BUILTIN_TASK_PROFILES } from "./profiles.ts";

export interface HarnessDescriptor {
	schemaVersion: 1;
	id: string;
	name: string;
	description: string;
	baseProfileId: string;
	createdAt: string;
}

export interface ResolvedHarnessDescriptor extends HarnessDescriptor {
	revision: string;
	evolvedNoteCount: number;
	harnessNoteCount: number;
	latestEvolutionAt?: string;
	sourcePath: string;
}

export interface HarnessDescriptorDiagnostic {
	type: "error";
	message: string;
	path: string;
}

export interface LoadHarnessDescriptorsResult {
	harnesses: readonly ResolvedHarnessDescriptor[];
	diagnostics: readonly HarnessDescriptorDiagnostic[];
}

export interface CreateHarnessDescriptorOptions {
	agentDir: string;
	name: string;
	description: string;
	baseProfileId: string;
	id?: string;
	createdAt?: string | Date;
	notes?: readonly EvolvedNote[];
}

const HARNESS_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_HARNESS_ID_LENGTH = 96;
const MAX_HARNESS_NAME_LENGTH = 80;
const MAX_HARNESS_DESCRIPTION_LENGTH = 500;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const DESCRIPTOR_FIELDS = new Set(["schemaVersion", "id", "name", "description", "baseProfileId", "createdAt"]);
const BUILTIN_PROFILE_IDS = new Set(BUILTIN_TASK_PROFILES.map((profile) => profile.id));

export const HARNESS_DESCRIPTORS_DIRECTORY = "harnesses";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStrictString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	const strict = value.trim();
	if (strict.length > maxLength) {
		throw new Error(`${field} must be at most ${maxLength} characters`);
	}
	return strict;
}

function normalizeDescriptorText(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`${field} must be a non-empty string`);
	const normalized = value
		.normalize("NFKC")
		.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength)
		.trim();
	if (!normalized) throw new Error(`${field} must be a non-empty string`);
	return normalized;
}

function requireId(value: unknown, field: string, maxLength = MAX_HARNESS_ID_LENGTH): string {
	const id = requireStrictString(value, field, maxLength);
	if (!HARNESS_ID_PATTERN.test(id)) {
		throw new Error(`${field} must contain lowercase letters, numbers, and interior hyphens only`);
	}
	return id;
}

function requireBuiltinProfileId(value: unknown): string {
	const id = requireId(value, "baseProfileId", 64);
	if (!BUILTIN_PROFILE_IDS.has(id)) {
		throw new Error(`baseProfileId must reference an immutable built-in profile: ${id}`);
	}
	return id;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || "task";
}

function descriptorDirectory(agentDir: string, create: boolean): string {
	const root = resolve(agentDir);
	const directory = join(root, HARNESS_DESCRIPTORS_DIRECTORY);
	if (!existsSync(directory) && create) mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (!existsSync(directory)) return directory;
	const stats = lstatSync(directory);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Refusing to use unsafe harness descriptor directory: ${directory}`);
	}
	const canonicalRoot = realpathSync(root);
	const canonicalDirectory = realpathSync(directory);
	const pathFromRoot = relative(canonicalRoot, canonicalDirectory);
	if (pathFromRoot.startsWith("..") || pathFromRoot.includes(`${sep}..${sep}`)) {
		throw new Error(`Refusing to use harness descriptor directory outside the agent directory: ${directory}`);
	}
	return canonicalDirectory;
}

/** Return the dedicated descriptor root so hosts can protect it from model-authored writes. */
export function getHarnessDescriptorsDirectory(agentDir: string, create = false): string {
	return descriptorDirectory(agentDir, create);
}

function parseDescriptor(value: unknown): HarnessDescriptor {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		throw new Error("schemaVersion must be 1");
	}
	const unexpectedField = Object.keys(value).find((field) => !DESCRIPTOR_FIELDS.has(field));
	if (unexpectedField) throw new Error(`unexpected descriptor field: ${unexpectedField}`);
	const createdAt = requireStrictString(value.createdAt, "createdAt", 64);
	if (Number.isNaN(Date.parse(createdAt))) throw new Error("createdAt must be a valid date");
	return {
		schemaVersion: 1,
		id: requireId(value.id, "id"),
		name: normalizeDescriptorText(value.name, "name", MAX_HARNESS_NAME_LENGTH),
		description: normalizeDescriptorText(value.description, "description", MAX_HARNESS_DESCRIPTION_LENGTH),
		baseProfileId: requireBuiltinProfileId(value.baseProfileId),
		createdAt,
	};
}

/** Select the evolution notes that affect a harness without mutating its base prompt profile. */
export function getApplicableHarnessNotes(
	descriptor: Pick<HarnessDescriptor, "id">,
	notes: readonly EvolvedNote[],
): readonly EvolvedNote[] {
	return notes.filter(
		(note) => note.profileId === descriptor.id || note.profileId === "*" || note.profileId === "all",
	);
}

export function resolveHarnessDescriptor(
	descriptor: HarnessDescriptor,
	sourcePath: string,
	notes: readonly EvolvedNote[],
): ResolvedHarnessDescriptor {
	const applicableNotes = getApplicableHarnessNotes(descriptor, notes);
	const revisionMaterial = applicableNotes
		.map((note) => `${note.scope}:${note.profileId}:${note.hash}`)
		.sort()
		.join("\n");
	const revision = createHash("sha256")
		.update(
			JSON.stringify({
				schemaVersion: descriptor.schemaVersion,
				id: descriptor.id,
				name: descriptor.name,
				description: descriptor.description,
				baseProfileId: descriptor.baseProfileId,
				createdAt: descriptor.createdAt,
				evolvedNotes: revisionMaterial,
			}),
		)
		.digest("hex");
	const latestEvolutionAt = applicableNotes
		.map((note) => note.timestamp)
		.sort((left, right) => right.localeCompare(left))[0];
	return {
		...descriptor,
		revision,
		evolvedNoteCount: applicableNotes.length,
		harnessNoteCount: applicableNotes.filter((note) => note.profileId === descriptor.id).length,
		...(latestEvolutionAt ? { latestEvolutionAt } : {}),
		sourcePath,
	};
}

export function loadHarnessDescriptors(options: {
	agentDir: string;
	notes?: readonly EvolvedNote[];
}): LoadHarnessDescriptorsResult {
	const notes = options.notes ?? [];
	const diagnostics: HarnessDescriptorDiagnostic[] = [];
	let directory: string;
	try {
		directory = descriptorDirectory(options.agentDir, false);
	} catch (error) {
		const path = join(resolve(options.agentDir), HARNESS_DESCRIPTORS_DIRECTORY);
		return {
			harnesses: [],
			diagnostics: [{ type: "error", message: error instanceof Error ? error.message : String(error), path }],
		};
	}
	if (!existsSync(directory)) return { harnesses: [], diagnostics: [] };

	const harnesses: ResolvedHarnessDescriptor[] = [];
	for (const fileName of readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.sort()) {
		const sourcePath = join(directory, fileName);
		try {
			const stats = lstatSync(sourcePath);
			if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("descriptor must be a regular file");
			if (stats.size > MAX_DESCRIPTOR_BYTES) throw new Error("descriptor exceeds the size limit");
			const descriptor = parseDescriptor(JSON.parse(readFileSync(sourcePath, "utf-8")));
			if (fileName !== `${descriptor.id}.json`) throw new Error("descriptor filename must match its id");
			harnesses.push(resolveHarnessDescriptor(descriptor, sourcePath, notes));
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
				path: sourcePath,
			});
		}
	}
	return {
		harnesses: Object.freeze(harnesses),
		diagnostics: Object.freeze(diagnostics),
	};
}

/** Persist identity and base-profile reference only. Prompt content never enters a descriptor. */
export function createHarnessDescriptor(options: CreateHarnessDescriptorOptions): ResolvedHarnessDescriptor {
	const name = normalizeDescriptorText(options.name, "name", MAX_HARNESS_NAME_LENGTH);
	const baseProfileId = requireBuiltinProfileId(options.baseProfileId);
	const id = options.id
		? requireId(options.id, "id")
		: `${slugify(name)}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
	const createdAt =
		options.createdAt instanceof Date
			? options.createdAt.toISOString()
			: (options.createdAt ?? new Date().toISOString());
	const descriptor = parseDescriptor({
		schemaVersion: 1,
		id,
		name,
		description: options.description,
		baseProfileId,
		createdAt,
	});
	const directory = getHarnessDescriptorsDirectory(options.agentDir, true);
	const sourcePath = join(directory, `${descriptor.id}.json`);
	const temporaryPath = join(directory, `.${descriptor.id}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		// Linking with a destination path is atomic and fails rather than replacing an existing descriptor.
		linkSync(temporaryPath, sourcePath);
	} finally {
		try {
			unlinkSync(temporaryPath);
		} catch {}
	}
	return resolveHarnessDescriptor(descriptor, sourcePath, options.notes ?? []);
}
