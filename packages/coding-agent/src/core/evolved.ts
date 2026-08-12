import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";

const NOTE_PREFIX = "<!-- pi:evolved-note ";
const NOTE_SUFFIX = " -->";
const NOTE_CONTENT_MARKER = "<!-- pi:evolved-content -->";
const NOTE_END_MARKER = "<!-- pi:evolved-note-end -->";
const DEFAULT_MAX_NOTES = 50;
const DEFAULT_MAX_BYTES = 64 * 1024;

export interface EvolvedLocationOptions {
	agentDir: string;
	cwd?: string;
	projectTrusted?: boolean;
}

export interface EvolvedPaths {
	globalPath: string;
	projectPath?: string;
}

type EvolvedNoteScope = "global" | "project";

export interface EvolvedNote {
	scope: EvolvedNoteScope;
	timestamp: string;
	profileId: string;
	category: string;
	provenance: string;
	content: string;
	hash: string;
	sourcePath: string;
}

export interface EvolvedDiagnostic {
	type: "warning" | "error";
	message: string;
	path: string;
}

export interface LoadEvolvedNotesOptions extends EvolvedLocationOptions {
	maxNotes?: number;
	maxBytes?: number;
}

export interface LoadEvolvedNotesResult {
	notes: readonly EvolvedNote[];
	paths: EvolvedPaths;
	diagnostics: readonly EvolvedDiagnostic[];
}

export interface AppendEvolvedNoteOptions extends EvolvedLocationOptions {
	scope: EvolvedNoteScope;
	profileId: string;
	category: string;
	provenance: string;
	content: string;
	timestamp?: string | Date;
}

interface StoredEvolvedNote {
	timestamp: string;
	profileId: string;
	category: string;
	provenance: string;
	content: string;
	hash: string;
}

function evolvedPaths(options: EvolvedLocationOptions): EvolvedPaths {
	const globalPath = join(resolve(options.agentDir), "EVOLVED.md");
	if (!options.projectTrusted || !options.cwd) return { globalPath };
	return { globalPath, projectPath: join(resolve(options.cwd), CONFIG_DIR_NAME, "EVOLVED.md") };
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function safeProjectEvolvedPath(projectPath: string, create: boolean): string {
	const configDirectory = dirname(projectPath);
	const projectDirectory = dirname(configDirectory);
	if (create) mkdirSync(projectDirectory, { recursive: true });
	if (!lstatIfExists(projectDirectory)) return projectPath;
	if (!statSync(projectDirectory).isDirectory()) {
		throw new Error(`Refusing to use EVOLVED.md under a non-directory project path: ${projectDirectory}`);
	}

	let configStats = lstatIfExists(configDirectory);
	if (!configStats && create) {
		mkdirSync(configDirectory, { mode: 0o700 });
		configStats = lstatSync(configDirectory);
	}
	if (!configStats) return projectPath;
	if (configStats.isSymbolicLink()) {
		throw new Error("Refusing to use EVOLVED.md through a symbolic-link directory");
	}
	if (!configStats.isDirectory()) {
		throw new Error(`Refusing to use non-directory project config path: ${configDirectory}`);
	}

	const canonicalProjectDirectory = realpathSync(projectDirectory);
	const canonicalConfigDirectory = realpathSync(configDirectory);
	if (relative(canonicalProjectDirectory, canonicalConfigDirectory) !== CONFIG_DIR_NAME) {
		throw new Error("Refusing to use EVOLVED.md outside the project config directory");
	}
	return join(canonicalConfigDirectory, "EVOLVED.md");
}

function ensureEmptyFile(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	try {
		const descriptor = openSync(filePath, "wx", 0o600);
		closeSync(descriptor);
	} catch (error) {
		const code = isNodeError(error) ? error.code : undefined;
		if (code !== "EEXIST") throw error;
		const stats = lstatSync(filePath);
		if (!stats.isFile() || stats.isSymbolicLink()) {
			throw new Error(`Refusing to use non-regular EVOLVED.md path: ${filePath}`);
		}
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export function initializeEvolvedFiles(options: EvolvedLocationOptions): EvolvedPaths {
	const paths = evolvedPaths(options);
	ensureEmptyFile(paths.globalPath);
	return paths;
}

function readFileTail(filePath: string, maxBytes: number): { text: string; truncated: boolean } {
	const descriptor = openSync(filePath, "r");
	try {
		const size = fstatSync(descriptor).size;
		const bytesToRead = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(bytesToRead);
		const offset = size - bytesToRead;
		readSync(descriptor, buffer, 0, bytesToRead, offset);
		let text = buffer.toString("utf-8");
		if (offset > 0) {
			const firstLineBreak = text.indexOf("\n");
			text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
		}
		return { text, truncated: offset > 0 };
	} finally {
		closeSync(descriptor);
	}
}

function noteHash(note: Omit<StoredEvolvedNote, "hash">): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				timestamp: note.timestamp,
				profileId: note.profileId,
				category: note.category,
				provenance: note.provenance,
				content: note.content,
			}),
		)
		.digest("hex");
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseStoredNote(value: unknown, sourcePath: string, scope: EvolvedNoteScope): EvolvedNote | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const note = value as Record<string, unknown>;
	if (
		!nonEmptyString(note.timestamp) ||
		Number.isNaN(Date.parse(note.timestamp)) ||
		!nonEmptyString(note.profileId) ||
		!nonEmptyString(note.category) ||
		!nonEmptyString(note.provenance) ||
		!nonEmptyString(note.content) ||
		!nonEmptyString(note.hash)
	) {
		return undefined;
	}
	const stored: StoredEvolvedNote = {
		timestamp: note.timestamp,
		profileId: note.profileId,
		category: note.category,
		provenance: note.provenance,
		content: note.content,
		hash: note.hash,
	};
	const expectedHash = noteHash(stored);
	if (stored.hash !== expectedHash) return undefined;
	return { ...stored, scope, sourcePath };
}

function parseNotesFromFile(
	filePath: string,
	scope: EvolvedNoteScope,
	maxBytes: number,
	diagnostics: EvolvedDiagnostic[],
): EvolvedNote[] {
	if (!existsSync(filePath)) return [];
	try {
		const stats = lstatSync(filePath);
		if (!stats.isFile() || stats.isSymbolicLink()) {
			diagnostics.push({ type: "error", message: "EVOLVED.md is not a regular file", path: filePath });
			return [];
		}
		const notes: EvolvedNote[] = [];
		const freeform: string[] = [];
		const tail = readFileTail(filePath, maxBytes);
		const lines = tail.text.split(/\r?\n/);
		let discardLeadingFragment = tail.truncated;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? "";
			if (discardLeadingFragment) {
				if (line === NOTE_END_MARKER) {
					discardLeadingFragment = false;
					continue;
				}
				if (!line.startsWith(NOTE_PREFIX) || !line.endsWith(NOTE_SUFFIX)) continue;
				discardLeadingFragment = false;
			}
			if (!line.startsWith(NOTE_PREFIX) || !line.endsWith(NOTE_SUFFIX)) {
				freeform.push(line);
				continue;
			}

			const encoded = line.slice(NOTE_PREFIX.length, -NOTE_SUFFIX.length);
			let storedNote: EvolvedNote | undefined;
			try {
				const parsed: unknown = JSON.parse(encoded);
				storedNote = parseStoredNote(parsed, filePath, scope);
			} catch {}

			const endIndex = lines.indexOf(NOTE_END_MARKER, index + 1);
			if (endIndex < 0) {
				if (storedNote) {
					notes.push(storedNote);
				} else {
					freeform.push(line);
				}
				continue;
			}

			const blockLines = lines.slice(index + 1, endIndex);
			const contentIndex = blockLines.indexOf(NOTE_CONTENT_MARKER);
			const visibleContent = (contentIndex >= 0 ? blockLines.slice(contentIndex + 1) : blockLines).join("\n").trim();
			if (storedNote && visibleContent.length > 0) {
				if (visibleContent === storedNote.content) {
					notes.push(storedNote);
				} else {
					const edited = {
						scope,
						timestamp: new Date(statSync(filePath).mtimeMs).toISOString(),
						profileId: storedNote.profileId,
						category: storedNote.category,
						provenance: "user",
						content: visibleContent,
					};
					notes.push({ ...edited, hash: noteHash(edited), sourcePath: filePath });
				}
			} else if (visibleContent.length > 0) {
				freeform.push(visibleContent);
				diagnostics.push({
					type: "warning",
					message: "Loaded note text as user-authored content because its machine metadata was invalid",
					path: filePath,
				});
			}
			index = endIndex;
		}

		const freeformContent = freeform.join("\n").trim();
		if (freeformContent.length > 0) {
			const userNote = {
				scope,
				timestamp: new Date(statSync(filePath).mtimeMs).toISOString(),
				profileId: "*",
				category: "freeform",
				provenance: "user",
				content: freeformContent,
			};
			notes.push({ ...userNote, hash: noteHash(userNote), sourcePath: filePath });
		}
		return notes;
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to load evolved notes";
		diagnostics.push({ type: "error", message, path: filePath });
		return [];
	}
}

function positiveBound(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;
}

function boundNotes(notes: readonly EvolvedNote[], maxNotes: number, maxBytes: number): EvolvedNote[] {
	const selected: EvolvedNote[] = [];
	const seen = new Set<string>();
	let byteCount = 0;
	for (let index = notes.length - 1; index >= 0 && selected.length < maxNotes; index--) {
		const note = notes[index];
		if (!note) continue;
		const dedupeKey = `${note.scope}:${note.hash}`;
		if (seen.has(dedupeKey)) continue;
		const noteBytes = Buffer.byteLength(JSON.stringify(note), "utf-8");
		if (byteCount + noteBytes > maxBytes) continue;
		seen.add(dedupeKey);
		byteCount += noteBytes;
		selected.unshift(note);
	}
	return selected;
}

export function loadEvolvedNotes(options: LoadEvolvedNotesOptions): LoadEvolvedNotesResult {
	const paths = evolvedPaths(options);
	const maxNotes = positiveBound(options.maxNotes, DEFAULT_MAX_NOTES);
	const maxBytes = positiveBound(options.maxBytes, DEFAULT_MAX_BYTES);
	const diagnostics: EvolvedDiagnostic[] = [];
	let projectPath: string | undefined;
	if (paths.projectPath) {
		try {
			safeProjectEvolvedPath(paths.projectPath, false);
			projectPath = paths.projectPath;
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: error instanceof Error ? error.message : "project EVOLVED.md path is unsafe",
				path: paths.projectPath,
			});
		}
	}
	const notes = [
		...parseNotesFromFile(paths.globalPath, "global", maxBytes, diagnostics),
		...(projectPath ? parseNotesFromFile(projectPath, "project", maxBytes, diagnostics) : []),
	].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
	return {
		notes: Object.freeze(boundNotes(notes, maxNotes, maxBytes)),
		paths,
		diagnostics: Object.freeze(diagnostics),
	};
}

function requiredNoteString(value: string, field: string): string {
	if (value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function requiredNoteContent(value: string): string {
	const content = requiredNoteString(value, "content");
	if (content.includes("<!-- pi:")) {
		throw new Error("content must not contain reserved EVOLVED.md control markers");
	}
	return content;
}

export function appendEvolvedNote(options: AppendEvolvedNoteOptions): EvolvedNote {
	const paths = initializeEvolvedFiles(options);
	let path = paths.globalPath;
	if (options.scope === "project") {
		if (!paths.projectPath) throw new Error("Project evolved notes require a trusted project and cwd");
		path = safeProjectEvolvedPath(paths.projectPath, true);
		ensureEmptyFile(path);
	}
	const timestamp =
		options.timestamp instanceof Date
			? options.timestamp.toISOString()
			: (options.timestamp ?? new Date().toISOString());
	if (Number.isNaN(Date.parse(timestamp))) throw new Error("timestamp must be a valid date");
	const withoutHash = {
		timestamp,
		profileId: requiredNoteString(options.profileId, "profileId"),
		category: requiredNoteString(options.category, "category"),
		provenance: requiredNoteString(options.provenance, "provenance"),
		content: requiredNoteContent(options.content),
	};
	const stored: StoredEvolvedNote = { ...withoutHash, hash: noteHash(withoutHash) };
	writeFileSync(path, `${renderStoredEvolvedNote(stored)}\n`, { flag: "a", encoding: "utf-8" });
	return { ...stored, scope: options.scope, sourcePath: path };
}

function markdownLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function renderStoredEvolvedNote(note: StoredEvolvedNote): string {
	return `${NOTE_PREFIX}${JSON.stringify(note)}${NOTE_SUFFIX}
### ${markdownLine(note.category)}

- Timestamp: ${note.timestamp}
- Profile: ${markdownLine(note.profileId)}
- Provenance: ${markdownLine(note.provenance)}

${NOTE_CONTENT_MARKER}
${note.content}
${NOTE_END_MARKER}`;
}
