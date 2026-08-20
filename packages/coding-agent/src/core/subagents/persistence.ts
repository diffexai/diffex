import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/diffex-agent-core";
import { uuidv7 } from "@earendil-works/diffex-ai";
import {
	assertValidSessionId,
	type CustomEntry,
	loadEntriesFromFile,
	persistSessionHeader,
	type SessionEntry,
	SessionManager,
} from "../session-manager.ts";
import { allToolNames, type ToolName } from "../tools/index.ts";
import { SUBAGENT_NAME_PATTERN, type SubagentStatus } from "./types.ts";

export const SUBAGENT_ROSTER_CUSTOM_TYPE = "diffex.subagents";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HARNESS_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SUBAGENT_STATUSES = new Set<SubagentStatus>(["queued", "running", "idle", "failed", "interrupted"]);

export interface ChildSnapshotV1 {
	readonly name: string;
	readonly task: string;
	readonly status: SubagentStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly result?: string;
	readonly error?: string;
	readonly childSessionId: string;
	readonly childLeafId: string | null;
	readonly config: {
		readonly model: { readonly provider: string; readonly id: string };
		readonly thinkingLevel: ThinkingLevel;
		readonly tools: readonly ToolName[];
		readonly harnessRevision: string | null;
	};
}

export interface RosterSnapshotV1 {
	readonly schemaVersion: 1;
	readonly agents: readonly ChildSnapshotV1[];
}

export type DecodedChildSnapshotV1 =
	| { readonly kind: "restorable"; readonly snapshot: ChildSnapshotV1 }
	| { readonly kind: "isolated"; readonly name: string; readonly error: string };

export interface DecodedRosterSnapshotV1 {
	readonly recognized: boolean;
	readonly children: readonly DecodedChildSnapshotV1[];
	readonly warnings: readonly string[];
}

export interface SelectedBranchRosterSnapshot {
	readonly found: boolean;
	readonly entryId?: string;
	readonly children: readonly DecodedChildSnapshotV1[];
	readonly warnings: readonly string[];
}

interface PathDeletionResult {
	readonly ok: boolean;
	readonly error?: string;
}

interface ParentSessionDeletion<T extends PathDeletionResult> {
	readonly parentResult: T;
	readonly ownedDirectoryMovedToTrash: boolean;
}

interface ChildCandidate {
	readonly name: string;
	readonly childSessionId?: string;
	readonly snapshot?: ChildSnapshotV1;
	readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEpochMilliseconds(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validateOptionalEpoch(
	record: Record<string, unknown>,
	key: "startedAt" | "completedAt",
	errors: string[],
): void {
	if (record[key] !== undefined && !isEpochMilliseconds(record[key]))
		errors.push(`${key} must be a non-negative integer`);
}

function validateOptionalString(record: Record<string, unknown>, key: "result" | "error", errors: string[]): void {
	if (record[key] !== undefined && typeof record[key] !== "string") errors.push(`${key} must be a string`);
}

export function assertValidChildSessionId(id: string): void {
	assertValidSessionId(id);
	if (!UUID_V7_PATTERN.test(id)) throw new Error(`Invalid subagent child session id: ${id}`);
}

function decodeChild(value: unknown): ChildCandidate | undefined {
	if (!isRecord(value)) return undefined;
	const name = value.name;
	if (typeof name !== "string" || !SUBAGENT_NAME_PATTERN.test(name)) return undefined;

	const errors: string[] = [];
	if (!isNonEmptyString(value.task)) errors.push("task must be a non-empty string");
	if (typeof value.status !== "string" || !SUBAGENT_STATUSES.has(value.status as SubagentStatus)) {
		errors.push("status is invalid");
	}
	if (!isEpochMilliseconds(value.createdAt)) errors.push("createdAt must be a non-negative integer");
	if (!isEpochMilliseconds(value.updatedAt)) errors.push("updatedAt must be a non-negative integer");
	validateOptionalEpoch(value, "startedAt", errors);
	validateOptionalEpoch(value, "completedAt", errors);
	validateOptionalString(value, "result", errors);
	validateOptionalString(value, "error", errors);

	const childSessionId = value.childSessionId;
	if (typeof childSessionId !== "string" || !UUID_V7_PATTERN.test(childSessionId)) {
		errors.push("childSessionId must be a UUIDv7 string");
	}
	if (value.childLeafId !== null && !isNonEmptyString(value.childLeafId)) {
		errors.push("childLeafId must be a non-empty string or null");
	}

	const config = value.config;
	if (!isRecord(config)) {
		errors.push("config must be an object");
	} else {
		const model = config.model;
		if (!isRecord(model) || !isNonEmptyString(model.provider) || !isNonEmptyString(model.id)) {
			errors.push("config.model must contain non-empty provider and id strings");
		}
		if (typeof config.thinkingLevel !== "string" || !THINKING_LEVELS.has(config.thinkingLevel as ThinkingLevel)) {
			errors.push("config.thinkingLevel is invalid");
		}
		if (!Array.isArray(config.tools)) {
			errors.push("config.tools must be an array");
		} else {
			const tools = config.tools;
			if (
				tools.some((tool) => typeof tool !== "string" || !allToolNames.has(tool as ToolName)) ||
				new Set(tools).size !== tools.length
			) {
				errors.push("config.tools must contain unique built-in tool names");
			}
		}
		if (
			config.harnessRevision !== null &&
			(typeof config.harnessRevision !== "string" || !HARNESS_VERSION_PATTERN.test(config.harnessRevision))
		) {
			errors.push("config.harnessRevision is invalid");
		}
	}

	if (errors.length > 0) {
		return {
			name,
			...(typeof childSessionId === "string" && UUID_V7_PATTERN.test(childSessionId) ? { childSessionId } : {}),
			errors,
		};
	}

	return {
		name,
		childSessionId: childSessionId as string,
		errors,
		snapshot: {
			name,
			task: value.task as string,
			status: value.status as SubagentStatus,
			createdAt: value.createdAt as number,
			updatedAt: value.updatedAt as number,
			...(value.startedAt === undefined ? {} : { startedAt: value.startedAt as number }),
			...(value.completedAt === undefined ? {} : { completedAt: value.completedAt as number }),
			...(value.result === undefined ? {} : { result: value.result as string }),
			...(value.error === undefined ? {} : { error: value.error as string }),
			childSessionId: childSessionId as string,
			childLeafId: value.childLeafId as string | null,
			config: {
				model: {
					provider: (config as Record<string, unknown>).model
						? (((config as Record<string, unknown>).model as Record<string, unknown>).provider as string)
						: "",
					id: (config as Record<string, unknown>).model
						? (((config as Record<string, unknown>).model as Record<string, unknown>).id as string)
						: "",
				},
				thinkingLevel: (config as Record<string, unknown>).thinkingLevel as ThinkingLevel,
				tools: [...((config as Record<string, unknown>).tools as ToolName[])],
				harnessRevision: (config as Record<string, unknown>).harnessRevision as string | null,
			},
		},
	};
}

export function decodeSubagentRosterSnapshot(data: unknown): DecodedRosterSnapshotV1 {
	if (!isRecord(data) || data.schemaVersion !== 1 || !Array.isArray(data.agents)) {
		return {
			recognized: false,
			children: [],
			warnings: ["Latest subagent roster snapshot is malformed or uses an unsupported schema version"],
		};
	}

	const warnings: string[] = [];
	const candidates: ChildCandidate[] = [];
	for (const [index, value] of data.agents.entries()) {
		const candidate = decodeChild(value);
		if (candidate) candidates.push(candidate);
		else warnings.push(`Omitted subagent roster entry ${index} because its name cannot be trusted`);
	}

	const nameCounts = new Map<string, number>();
	const idOwners = new Map<string, Set<string>>();
	for (const candidate of candidates) {
		nameCounts.set(candidate.name, (nameCounts.get(candidate.name) ?? 0) + 1);
		if (candidate.childSessionId) {
			const owners = idOwners.get(candidate.childSessionId) ?? new Set<string>();
			owners.add(candidate.name);
			idOwners.set(candidate.childSessionId, owners);
		}
	}

	const emittedNames = new Set<string>();
	const children: DecodedChildSnapshotV1[] = [];
	for (const candidate of candidates) {
		if (emittedNames.has(candidate.name)) continue;
		emittedNames.add(candidate.name);

		let error: string | undefined;
		if ((nameCounts.get(candidate.name) ?? 0) > 1) {
			error = `Duplicate persisted subagent name: ${candidate.name}`;
		} else if (candidate.childSessionId && (idOwners.get(candidate.childSessionId)?.size ?? 0) > 1) {
			error = `Persisted child session ${candidate.childSessionId} is claimed by multiple subagents`;
		} else if (candidate.errors.length > 0) {
			error = `Invalid persisted subagent ${candidate.name}: ${candidate.errors.join("; ")}`;
		}

		if (error) {
			children.push({ kind: "isolated", name: candidate.name, error });
			warnings.push(error);
		} else if (candidate.snapshot) {
			children.push({ kind: "restorable", snapshot: candidate.snapshot });
		}
	}

	return { recognized: true, children, warnings };
}

export function encodeSubagentRosterSnapshot(agents: readonly ChildSnapshotV1[]): RosterSnapshotV1 {
	const data = { schemaVersion: 1 as const, agents: structuredClone(agents) };
	const decoded = decodeSubagentRosterSnapshot(data);
	if (
		!decoded.recognized ||
		decoded.warnings.length > 0 ||
		decoded.children.some((child) => child.kind === "isolated")
	) {
		throw new Error(decoded.warnings[0] ?? "Invalid subagent roster snapshot");
	}
	return data;
}

function isRosterEntry(entry: SessionEntry): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === SUBAGENT_ROSTER_CUSTOM_TYPE;
}

export function readSelectedBranchSubagentRoster(sessionManager: SessionManager): SelectedBranchRosterSnapshot {
	const branch = sessionManager.getBranch();
	let entry: CustomEntry | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const candidate = branch[index];
		if (isRosterEntry(candidate)) {
			entry = candidate;
			break;
		}
	}
	if (!entry) return { found: false, children: [], warnings: [] };
	const decoded = decodeSubagentRosterSnapshot(entry.data);
	return {
		found: true,
		entryId: entry.id,
		children: decoded.children,
		warnings: decoded.warnings,
	};
}

function assertContainedPath(parentDirectory: string, targetPath: string): void {
	const childPath = relative(parentDirectory, targetPath);
	if (childPath === "" || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
		throw new Error(`Subagent path escapes the parent session directory: ${targetPath}`);
	}
}

function assertSafeDirectory(path: string, description: string): void {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isDirectory())
		throw new Error(`${description} is not a safe directory: ${path}`);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function ensureSafeDirectory(path: string, parentDirectory: string, description: string): void {
	assertContainedPath(parentDirectory, path);
	if (!existsSync(path)) mkdirSync(path);
	assertSafeDirectory(path, description);
}

/** Internal helper for deleting a parent and only its validated, recoverably trashed child namespace. */
export async function deleteParentSessionWithOwnedSubagents<T extends PathDeletionResult>(
	parentSessionFile: string,
	moveOwnedDirectoryToTrash: (ownedDirectory: string) => Promise<void>,
	deleteParentSessionFile: (parentSessionFile: string) => Promise<T>,
): Promise<ParentSessionDeletion<T>> {
	const resolvedParentFile = resolve(parentSessionFile);
	const header = loadEntriesFromFile(resolvedParentFile)[0];
	if (header?.type !== "session") throw new Error(`Session header is unavailable: ${resolvedParentFile}`);
	assertValidSessionId(header.id);

	const parentDirectory = dirname(resolvedParentFile);
	const namespaceDirectory = resolve(parentDirectory, ".subagents");
	const ownedDirectory = resolve(namespaceDirectory, header.id);
	assertContainedPath(parentDirectory, namespaceDirectory);
	assertContainedPath(parentDirectory, ownedDirectory);

	let ownedDirectoryMovedToTrash = false;
	const namespaceStats = lstatIfPresent(namespaceDirectory);
	if (namespaceStats) {
		if (namespaceStats.isSymbolicLink() || !namespaceStats.isDirectory()) {
			throw new Error(`Subagent namespace is not a safe directory: ${namespaceDirectory}`);
		}

		const ownedStats = lstatIfPresent(ownedDirectory);
		if (ownedStats) {
			if (ownedStats.isSymbolicLink() || !ownedStats.isDirectory()) {
				throw new Error(`Parent-owned subagent directory is not a safe directory: ${ownedDirectory}`);
			}
			await moveOwnedDirectoryToTrash(ownedDirectory);
			if (lstatIfPresent(ownedDirectory)) {
				throw new Error(`Parent-owned subagent directory remains after trash operation: ${ownedDirectory}`);
			}
			ownedDirectoryMovedToTrash = true;
		}
	}

	return {
		parentResult: await deleteParentSessionFile(resolvedParentFile),
		ownedDirectoryMovedToTrash,
	};
}

export class ParentOwnedSubagentSessionStore {
	readonly #parent: SessionManager;
	readonly #parentDirectory: string;
	readonly #namespaceDirectory: string;
	readonly #ownedDirectory: string;

	constructor(parent: SessionManager) {
		if (!parent.isPersisted()) throw new Error("Parent-owned subagent storage requires a persisted parent session");
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Persisted parent session file is unavailable");
		assertValidSessionId(parent.getSessionId());

		this.#parent = parent;
		this.#parentDirectory = dirname(resolve(parentFile));
		this.#namespaceDirectory = resolve(this.#parentDirectory, ".subagents");
		this.#ownedDirectory = resolve(this.#namespaceDirectory, parent.getSessionId());
		assertContainedPath(this.#parentDirectory, this.#namespaceDirectory);
		assertContainedPath(this.#parentDirectory, this.#ownedDirectory);
	}

	getOwnedDirectory(): string {
		return this.#ownedDirectory;
	}

	createChild(childName: string, childSessionId: string = uuidv7()): SessionManager {
		if (!SUBAGENT_NAME_PATTERN.test(childName)) throw new Error(`Invalid subagent name: ${childName}`);
		assertValidChildSessionId(childSessionId);
		ensureSafeDirectory(this.#namespaceDirectory, this.#parentDirectory, "Subagent namespace");
		ensureSafeDirectory(this.#ownedDirectory, this.#parentDirectory, "Parent-owned subagent directory");

		const child = SessionManager.create(this.#parent.getCwd(), this.#ownedDirectory, {
			id: childSessionId,
			parentSession: this.#parent.getSessionId(),
		});
		const childFile = child.getSessionFile();
		if (!childFile) throw new Error("Child session file is unavailable");
		assertContainedPath(this.#ownedDirectory, resolve(childFile));
		persistSessionHeader(child);
		return child;
	}

	#validateChildFile(childName: string, childSessionId: string, childLeafId: string | null): string {
		if (!SUBAGENT_NAME_PATTERN.test(childName)) throw new Error(`Invalid subagent name: ${childName}`);
		assertValidChildSessionId(childSessionId);
		if (childLeafId !== null && !isNonEmptyString(childLeafId)) {
			throw new Error("Subagent child leaf id must be a non-empty string or null");
		}
		assertSafeDirectory(this.#namespaceDirectory, "Subagent namespace");
		assertSafeDirectory(this.#ownedDirectory, "Parent-owned subagent directory");

		const suffix = `_${childSessionId}.jsonl`;
		const matches = readdirSync(this.#ownedDirectory, { withFileTypes: true }).filter((entry) =>
			entry.name.endsWith(suffix),
		);
		if (matches.length !== 1) {
			throw new Error(`Expected one persisted child session for ${childName}, found ${matches.length}`);
		}
		const match = matches[0];
		const childFile = resolve(this.#ownedDirectory, match.name);
		assertContainedPath(this.#ownedDirectory, childFile);
		if (match.isSymbolicLink() || !match.isFile())
			throw new Error(`Persisted child session is not a safe file: ${childFile}`);

		const entries = loadEntriesFromFile(childFile);
		const header = entries[0];
		if (
			header?.type !== "session" ||
			header.id !== childSessionId ||
			header.parentSession !== this.#parent.getSessionId()
		) {
			throw new Error(`Persisted child session identity mismatch for ${childName}`);
		}
		if (childLeafId !== null && !entries.some((entry) => entry.type !== "session" && entry.id === childLeafId)) {
			throw new Error(`Persisted child leaf ${childLeafId} is unavailable for ${childName}`);
		}
		return childFile;
	}

	validateChild(childName: string, childSessionId: string, childLeafId: string | null): void {
		this.#validateChildFile(childName, childSessionId, childLeafId);
	}

	openChild(childName: string, childSessionId: string, childLeafId: string | null): SessionManager {
		const childFile = this.#validateChildFile(childName, childSessionId, childLeafId);
		const child = SessionManager.open(childFile, this.#ownedDirectory, this.#parent.getCwd());
		if (childLeafId === null) child.resetLeaf();
		else child.branch(childLeafId);
		return child;
	}
}
