import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readHomebrewFile } from "./homebrew-runtime.mjs";

/** Resolve only descendants of trusted local roots, never symlinked components. */
export function resolveReleaseDirectory(value) {
	if (typeof value !== "string" || !value || /[\x00-\x1f]/.test(value)) throw new Error("Invalid artifact directory");
	// macOS exposes /var through a system-owned alias of /private/var. The
	// subprocess may have a canonical cwd but receive the lexical path from its
	// parent, even after TMPDIR was intentionally removed from its environment.
	const directory = process.platform === "darwin" && resolve(value).startsWith("/var/")
		? join(realpathSync("/var"), relative("/var", resolve(value))) : resolve(value);
	for (const base of [process.cwd(), realpathSync(process.cwd()), tmpdir(), realpathSync(tmpdir()), homedir(), "/tmp", realpathSync("/tmp")]) {
		const root = resolve(base);
		if (!directory.startsWith(root + sep)) continue;
		const local = relative(root, directory);
		let current = realpathSync(root);
		for (const component of local.split(sep)) {
			current = join(current, component);
			const entry = lstatSync(current, { throwIfNoEntry: false });
			if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
				throw new Error("Artifact directory must not traverse symlinks or non-directory components");
		}
		return current;
	}
	throw new Error("Artifact directory must be inside the workspace, home, or temporary directory");
}

export function releaseFilePath(directory, name) {
	if (typeof name !== "string" || !name || name === "." || name === ".." ||
		basename(name) !== name || /[\\/\x00-\x1f]/.test(name)) throw new Error("Invalid retained artifact filename");
	const root = resolveReleaseDirectory(directory);
	const file = resolve(root, name);
	const local = relative(root, file);
	if (local.startsWith(".." + sep) || isAbsolute(local)) throw new Error("Retained artifact escapes directory");
	return file;
}

export function readRetainedFile(directory, name, limit, encoding) {
	const bytes = readHomebrewFile(releaseFilePath(directory, name), limit);
	return encoding ? bytes.toString(encoding) : bytes;
}

/** Creation and no-replace semantics are one filesystem operation, not an existence check. */
export function writeRetainedFile(directory, name, bytes) {
	const fd = openSync(releaseFilePath(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("Invalid retained artifact file type");
		writeFileSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}
