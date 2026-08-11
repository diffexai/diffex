import { randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	type Stats,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface SelfEvolutionProtectionOptions {
	cwd: string;
	protectedPaths: readonly string[];
	protectedRoots?: readonly string[];
	quarantineDir?: string;
	allowedMutationPath?: string;
	/** Project config directory name used to scope implicitly protected file names. Default: ".pi". */
	configDirName?: string;
}

export interface SelfEvolutionPolicyViolation {
	path: string;
	reason: string;
}

type ProtectedStateEntry =
	| { relativePath: string; kind: "directory"; mode: number }
	| { relativePath: string; kind: "file"; mode: number; content: Buffer }
	| { relativePath: string; kind: "symlink"; target: string };

interface ProtectedAncestorIdentity {
	path: string;
	device: number;
	inode: number;
}

interface ProtectedTargetSnapshot {
	path: string;
	recursive: boolean;
	entries: ProtectedStateEntry[];
	ancestors: readonly ProtectedAncestorIdentity[];
	allowedMutationPath?: string;
}

export interface SelfEvolutionProtectionSnapshot {
	quarantineDir?: string;
	targets: readonly ProtectedTargetSnapshot[];
}

export interface SelfEvolutionRestoreResult {
	restoredPaths: readonly string[];
	quarantinePath?: string;
	errors: readonly SelfEvolutionPolicyViolation[];
}

const USER_CONTROLLED_FILE_NAMES = new Set([
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
	"EVOLVED.md",
]);

/**
 * Programs that can rewrite a file given to them, including interpreters that can be handed inline
 * code. Output redirection is handled separately, per path, by `commandRedirectsToPath`.
 */
const MUTATING_SHELL_COMMAND =
	/(?:^|[;&|]\s*)(?:command\s+|sudo\s+)*(?:apply_patch|bash|chmod|chown|cp|dd|git\s+[^;&|]*(?:apply|checkout|clean|reset|restore)|install|ln|mv|node|perl|php|powershell|pwsh|python(?:3)?|rm|ruby|sed\s+[^;&|]*-[^;&|\s]*i|sh|tee|touch|truncate|zsh)\b/i;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function lstatIfPresent(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function isPathInside(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function ancestorPaths(path: string): string[] {
	const paths: string[] = [];
	let current = dirname(path);
	while (true) {
		paths.unshift(current);
		const parent = dirname(current);
		if (parent === current) return paths;
		current = parent;
	}
}

function captureAncestorIdentities(path: string): ProtectedAncestorIdentity[] {
	return ancestorPaths(path).map((ancestorPath) => {
		const stats = lstatIfPresent(ancestorPath);
		if (!stats) throw new Error(`Cannot protect a path through a missing ancestor: ${ancestorPath}`);
		if (stats.isSymbolicLink()) {
			throw new Error(`Cannot protect a path through a symbolic-link ancestor: ${ancestorPath}`);
		}
		if (!stats.isDirectory()) {
			throw new Error(`Cannot protect a path through a non-directory ancestor: ${ancestorPath}`);
		}
		return { path: ancestorPath, device: stats.dev, inode: stats.ino };
	});
}

function changedAncestor(snapshot: ProtectedTargetSnapshot): SelfEvolutionPolicyViolation | undefined {
	for (const ancestor of snapshot.ancestors) {
		const stats = lstatIfPresent(ancestor.path);
		if (
			!stats ||
			stats.isSymbolicLink() ||
			!stats.isDirectory() ||
			stats.dev !== ancestor.device ||
			stats.ino !== ancestor.inode
		) {
			return {
				path: snapshot.path,
				reason: `Refusing to inspect or restore protected state because ancestor identity changed: ${ancestor.path}`,
			};
		}
	}
	return undefined;
}

function captureTarget(path: string, recursive: boolean, allowedMutationPath?: string): ProtectedTargetSnapshot {
	const ancestors = captureAncestorIdentities(path);
	const entries: ProtectedStateEntry[] = [];
	const visit = (currentPath: string, relativePath: string): void => {
		const stats = lstatIfPresent(currentPath);
		if (!stats) return;
		if (stats.isSymbolicLink()) {
			entries.push({ relativePath, kind: "symlink", target: readlinkSync(currentPath) });
			return;
		}
		if (stats.isDirectory()) {
			entries.push({ relativePath, kind: "directory", mode: stats.mode & 0o7777 });
			if (recursive) {
				for (const name of readdirSync(currentPath).sort()) {
					visit(join(currentPath, name), relativePath ? join(relativePath, name) : name);
				}
			}
			return;
		}
		if (stats.isFile()) {
			entries.push({
				relativePath,
				kind: "file",
				mode: stats.mode & 0o7777,
				content: readFileSync(currentPath),
			});
			return;
		}
		throw new Error(`Cannot safely protect non-regular filesystem entry: ${currentPath}`);
	};
	visit(path, "");
	return { path, recursive, entries, ancestors, allowedMutationPath };
}

function targetSnapshotsEqual(before: ProtectedTargetSnapshot, after: ProtectedTargetSnapshot): boolean {
	const allowedPath = before.allowedMutationPath;
	let beforeEntries = before.entries;
	let afterEntries = after.entries;
	if (allowedPath && isPathInside(before.path, allowedPath)) {
		const allowedRelativePath = relative(before.path, allowedPath);
		const beforePaths = new Set(before.entries.map((entry) => entry.relativePath));
		const allowedAncestors = new Set<string>([""]);
		let current = dirname(allowedRelativePath);
		while (current !== "." && current !== "") {
			allowedAncestors.add(current);
			current = dirname(current);
		}
		const includeEntry = (entry: ProtectedStateEntry): boolean => {
			if (isPathInside(allowedRelativePath, entry.relativePath)) return false;
			return !(
				entry.kind === "directory" &&
				allowedAncestors.has(entry.relativePath) &&
				!beforePaths.has(entry.relativePath)
			);
		};
		beforeEntries = before.entries.filter(includeEntry);
		afterEntries = after.entries.filter(includeEntry);
	}
	if (beforeEntries.length !== afterEntries.length) return false;
	for (let index = 0; index < beforeEntries.length; index++) {
		const left = beforeEntries[index];
		const right = afterEntries[index];
		if (left.relativePath !== right.relativePath || left.kind !== right.kind) return false;
		if (left.kind === "symlink" && right.kind === "symlink") {
			if (left.target !== right.target) return false;
		} else if (left.kind === "directory" && right.kind === "directory") {
			if (left.mode !== right.mode) return false;
		} else if (left.kind === "file" && right.kind === "file") {
			if (left.mode !== right.mode || !left.content.equals(right.content)) return false;
		}
	}
	return true;
}

function materializeTarget(snapshot: ProtectedTargetSnapshot): void {
	if (lstatIfPresent(snapshot.path)) {
		rmSync(snapshot.path, { recursive: true, force: true });
	}
	if (snapshot.entries.length === 0) return;

	const directories = snapshot.entries
		.filter((entry): entry is Extract<ProtectedStateEntry, { kind: "directory" }> => entry.kind === "directory")
		.sort((left, right) => left.relativePath.split(sep).length - right.relativePath.split(sep).length);
	for (const entry of directories) {
		const outputPath = entry.relativePath ? join(snapshot.path, entry.relativePath) : snapshot.path;
		mkdirSync(outputPath, { recursive: true, mode: entry.mode });
	}

	for (const entry of snapshot.entries) {
		if (entry.kind === "directory") continue;
		const outputPath = entry.relativePath ? join(snapshot.path, entry.relativePath) : snapshot.path;
		mkdirSync(dirname(outputPath), { recursive: true });
		if (entry.kind === "file") {
			writeFileSync(outputPath, entry.content, { mode: entry.mode });
			chmodSync(outputPath, entry.mode);
		} else {
			symlinkSync(entry.target, outputPath);
		}
	}

	for (const entry of directories.sort(
		(left, right) => right.relativePath.split(sep).length - left.relativePath.split(sep).length,
	)) {
		const outputPath = entry.relativePath ? join(snapshot.path, entry.relativePath) : snapshot.path;
		chmodSync(outputPath, entry.mode);
	}
}

function captureAllowedMutation(
	before: ProtectedTargetSnapshot,
	after: ProtectedTargetSnapshot,
): ProtectedTargetSnapshot | undefined {
	const allowedPath = before.allowedMutationPath;
	if (!allowedPath || !isPathInside(before.path, allowedPath)) return undefined;
	const allowedRelativePath = relative(before.path, allowedPath);
	const entries = after.entries
		.filter((entry) => isPathInside(allowedRelativePath, entry.relativePath))
		.map((entry): ProtectedStateEntry => {
			const relativePath = relative(allowedRelativePath, entry.relativePath);
			if (entry.kind === "file") return { ...entry, relativePath };
			if (entry.kind === "directory") return { ...entry, relativePath };
			return { ...entry, relativePath };
		});
	if (entries.length === 0) return undefined;

	const afterByPath = new Map(after.entries.map((entry) => [entry.relativePath, entry]));
	let current = dirname(allowedRelativePath);
	while (current !== "." && current !== "") {
		if (afterByPath.get(current)?.kind !== "directory") return undefined;
		current = dirname(current);
	}
	if (afterByPath.get("")?.kind !== "directory") return undefined;

	return {
		path: allowedPath,
		recursive: true,
		entries,
		ancestors: [],
	};
}

function writeQuarantineSnapshot(snapshot: ProtectedTargetSnapshot, outputDir: string): void {
	mkdirSync(outputDir, { recursive: true, mode: 0o700 });
	const entries = snapshot.entries.map((entry) => {
		if (entry.kind !== "file") return entry;
		const storedPath = join("files", entry.relativePath || "__root__");
		const outputPath = join(outputDir, storedPath);
		mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
		writeFileSync(outputPath, entry.content, { mode: 0o600 });
		return {
			relativePath: entry.relativePath,
			kind: entry.kind,
			mode: entry.mode,
			storedPath,
		};
	});
	writeFileSync(
		join(outputDir, "manifest.json"),
		`${JSON.stringify(
			{
				originalPath: snapshot.path,
				recursive: snapshot.recursive,
				allowedMutationPath: snapshot.allowedMutationPath,
				entries,
			},
			null,
			2,
		)}\n`,
		{ encoding: "utf-8", mode: 0o600 },
	);
}

function addCanonicalTarget(targets: Map<string, boolean>, path: string, recursive: boolean): void {
	const resolvedPath = resolve(path);
	targets.set(resolvedPath, (targets.get(resolvedPath) ?? false) || recursive);
	try {
		const canonicalPath = realpathSync(resolvedPath);
		targets.set(canonicalPath, (targets.get(canonicalPath) ?? false) || recursive);
	} catch {
		// Missing paths still need a snapshot so unauthorized creation is detected.
	}
}

function stabilizeTargets(path: string, recursive: boolean): Array<{ path: string; recursive: boolean }> {
	for (const ancestorPath of ancestorPaths(path)) {
		const stats = lstatIfPresent(ancestorPath);
		if (!stats) {
			return [{ path: ancestorPath, recursive: true }];
		}
		if (stats.isSymbolicLink()) {
			const canonicalAncestor = realpathSync(ancestorPath);
			return [
				{ path: ancestorPath, recursive: false },
				...stabilizeTargets(resolve(canonicalAncestor, relative(ancestorPath, path)), recursive),
			];
		}
		if (!stats.isDirectory()) {
			throw new Error(`Cannot protect a path through a non-directory ancestor: ${ancestorPath}`);
		}
	}
	return [{ path, recursive }];
}

function canonicalizeSymlinkAncestors(path: string): string {
	for (const ancestorPath of ancestorPaths(path)) {
		const stats = lstatIfPresent(ancestorPath);
		if (!stats) return path;
		if (stats.isSymbolicLink()) {
			return canonicalizeSymlinkAncestors(resolve(realpathSync(ancestorPath), relative(ancestorPath, path)));
		}
	}
	return path;
}

/**
 * Capture the complete protected state immediately before a model tool runs.
 * Profile roots are recursive so unauthorized new profiles are detected too.
 */
export function snapshotSelfEvolutionProtection(
	options: SelfEvolutionProtectionOptions,
): SelfEvolutionProtectionSnapshot {
	const targets = new Map<string, boolean>();
	for (const path of options.protectedPaths) addCanonicalTarget(targets, resolve(options.cwd, path), false);
	for (const root of options.protectedRoots ?? []) addCanonicalTarget(targets, resolve(options.cwd, root), true);
	for (const fileName of USER_CONTROLLED_FILE_NAMES) {
		addCanonicalTarget(targets, resolve(options.cwd, fileName), false);
	}
	const allowedTargets = new Set<string>();
	if (options.allowedMutationPath) {
		const allowedPath = resolve(options.cwd, options.allowedMutationPath);
		allowedTargets.add(allowedPath);
		allowedTargets.add(canonicalizeSymlinkAncestors(allowedPath));
		try {
			allowedTargets.add(realpathSync(allowedPath));
		} catch {}
	}
	const stableTargets = new Map<string, { recursive: boolean; allowedMutationPath?: string }>();
	for (const [path, recursive] of targets) {
		for (const stable of stabilizeTargets(path, recursive)) {
			if (allowedTargets.has(stable.path)) continue;
			const existing = stableTargets.get(stable.path);
			const allowedMutationPath = stable.recursive
				? [...allowedTargets].find((allowedPath) => isPathInside(stable.path, allowedPath))
				: undefined;
			stableTargets.set(stable.path, {
				recursive: (existing?.recursive ?? false) || stable.recursive,
				allowedMutationPath: existing?.allowedMutationPath ?? allowedMutationPath,
			});
		}
	}

	const recursiveRoots = [...stableTargets]
		.filter(([, target]) => target.recursive)
		.map(([path]) => path)
		.filter(
			(root, index, roots) =>
				!roots.some((candidate, candidateIndex) => candidateIndex !== index && isPathInside(candidate, root)),
		);
	const selectedTargets = [...stableTargets]
		.filter(([path, target]) => target.recursive || !recursiveRoots.some((root) => isPathInside(root, path)))
		.map(([path, target]) => ({ path, ...target }))
		.sort((left, right) => left.path.localeCompare(right.path));

	return {
		quarantineDir: options.quarantineDir,
		targets: selectedTargets.map(({ path, recursive, allowedMutationPath }) =>
			captureTarget(path, recursive, allowedMutationPath),
		),
	};
}

/**
 * Verify protected state after a tool call, preserve rejected versions, and restore the snapshot.
 * Restoration never starts unless every changed post-tool tree was copied to quarantine successfully.
 */
export function restoreSelfEvolutionProtection(snapshot: SelfEvolutionProtectionSnapshot): SelfEvolutionRestoreResult {
	const changed: Array<{ before: ProtectedTargetSnapshot; after: ProtectedTargetSnapshot }> = [];
	const errors: SelfEvolutionPolicyViolation[] = [];
	for (const before of snapshot.targets) {
		const ancestorViolation = changedAncestor(before);
		if (ancestorViolation) {
			errors.push(ancestorViolation);
			continue;
		}
		try {
			const after = captureTarget(before.path, before.recursive);
			const postCaptureAncestorViolation = changedAncestor(before);
			if (postCaptureAncestorViolation) {
				errors.push(postCaptureAncestorViolation);
				continue;
			}
			if (!targetSnapshotsEqual(before, after)) changed.push({ before, after });
		} catch (error) {
			errors.push({
				path: before.path,
				reason: `Refusing to inspect protected state after its path became unsafe: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	if (changed.length === 0) return { restoredPaths: [], errors };

	const quarantineRoot = resolve(snapshot.quarantineDir ?? join(tmpdir(), "pi-self-evolution-quarantine"));
	const quarantinePath = join(quarantineRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
	try {
		mkdirSync(quarantinePath, { recursive: true, mode: 0o700 });
		for (const [index, { after }] of changed.entries()) {
			writeQuarantineSnapshot(after, join(quarantinePath, `target-${index + 1}-${basename(after.path) || "root"}`));
		}
	} catch (error) {
		return {
			restoredPaths: [],
			quarantinePath,
			errors: [
				...errors,
				{
					path: quarantinePath,
					reason: `Protected state changed, but its rejected version could not be fully quarantined: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}

	const restoredPaths: string[] = [];
	for (const { before, after } of changed) {
		const ancestorViolation = changedAncestor(before);
		if (ancestorViolation) {
			errors.push(ancestorViolation);
			continue;
		}
		try {
			const allowedMutation = captureAllowedMutation(before, after);
			materializeTarget(before);
			if (allowedMutation) materializeTarget(allowedMutation);
			restoredPaths.push(before.path);
		} catch (error) {
			errors.push({
				path: before.path,
				reason: `Failed to restore protected state after preserving the rejected version: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
	return { restoredPaths, quarantinePath, errors };
}

function normalizePath(path: string, cwd: string): string {
	const resolved = resolve(cwd, path);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/**
 * Whether an implicitly protected file name at this location could supply instructions to a session
 * rooted at `cwd`: the working directory itself, any ancestor of it, or the project config directory.
 *
 * Scoping matters because the file names are generic. Without it, writing an unrelated
 * `packages/new-pkg/AGENTS.md` inside the repository would be refused even though nothing loads it.
 */
function isInstructionScope(candidate: string, options: SelfEvolutionProtectionOptions): boolean {
	const cwd = resolve(options.cwd);
	const directory = dirname(candidate);
	if (isPathInside(directory, cwd)) return true;
	return directory === join(cwd, options.configDirName ?? ".pi");
}

function getProtectedPath(path: string, options: SelfEvolutionProtectionOptions): string | undefined {
	const candidate = normalizePath(path, options.cwd);
	const explicitPath = options.protectedPaths.find(
		(protectedPath) => normalizePath(protectedPath, options.cwd) === candidate,
	);
	if (explicitPath) return explicitPath;
	if (USER_CONTROLLED_FILE_NAMES.has(basename(candidate)) && isInstructionScope(candidate, options)) {
		return candidate;
	}
	return undefined;
}

function pathAliases(protectedPath: string, cwd: string): string[] {
	const normalizedPath = normalizePath(protectedPath, cwd);
	const relativePath = relative(cwd, normalizedPath);
	const aliases = new Set([normalizedPath, relativePath, `./${relativePath}`]);
	if (dirname(normalizedPath) === resolve(cwd) || USER_CONTROLLED_FILE_NAMES.has(basename(normalizedPath))) {
		aliases.add(basename(normalizedPath));
	}
	return [...aliases].filter((alias) => alias.length > 0);
}

function commandReferencesPath(command: string, protectedPath: string, cwd: string): boolean {
	return pathAliases(protectedPath, cwd).some((alias) => command.includes(alias));
}

/**
 * Whether the command redirects output into the protected path itself.
 *
 * Checked per path rather than treating any `>` in the command as mutating, so a read-only command
 * that merely mentions a protected file while redirecting elsewhere is not refused. For example
 * `grep -rn "CLAUDE.md" src > /tmp/out` writes only to /tmp/out.
 */
function commandRedirectsToPath(command: string, protectedPath: string, cwd: string): boolean {
	return pathAliases(protectedPath, cwd).some((alias) => {
		const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`>{1,2}\\s*['"]?${escaped}`).test(command);
	});
}

/**
 * Enforce the self-evolution write boundary for model-initiated tool calls.
 *
 * This check is intentionally independent of prompt instructions. It protects
 * loaded user instructions, profiles, and evolution logs from direct mutation.
 * The dedicated evolve tool writes through a separate, validated callback.
 */
export function findSelfEvolutionPolicyViolation(
	toolName: string,
	input: Record<string, unknown>,
	options: SelfEvolutionProtectionOptions,
): SelfEvolutionPolicyViolation | undefined {
	if (toolName === "edit" || toolName === "write") {
		const inputPath = input.path;
		if (typeof inputPath !== "string") {
			return undefined;
		}
		const protectedPath = getProtectedPath(inputPath, options);
		if (!protectedPath) {
			return undefined;
		}
		return {
			path: protectedPath,
			reason: `${basename(protectedPath)} is read-only to the model. Update EVOLVED.md through the evolve tool, or edit this file as the user.`,
		};
	}

	if (toolName !== "bash") {
		return undefined;
	}
	const command = input.command;
	if (typeof command !== "string") {
		return undefined;
	}
	const candidatePaths = [
		...options.protectedPaths,
		...[...USER_CONTROLLED_FILE_NAMES].map((fileName) => resolve(options.cwd, fileName)),
	];
	// A command is refused when it runs a file-mutating program while naming a protected path, or when
	// it redirects output straight into one. Both halves must involve the same protected path.
	const runsMutatingProgram = MUTATING_SHELL_COMMAND.test(command);
	const protectedPath = candidatePaths.find(
		(path) =>
			commandRedirectsToPath(command, path, options.cwd) ||
			(runsMutatingProgram && commandReferencesPath(command, path, options.cwd)),
	);
	if (!protectedPath) {
		return undefined;
	}
	return {
		path: protectedPath,
		reason: `${basename(protectedPath)} is read-only to the model. Use read-only shell commands or the evolve tool.`,
	};
}
