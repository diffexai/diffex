import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

export const HOMEBREW_UPDATE_COMMAND = "brew upgrade diffexai/tap/diffex";

export interface BundledRuntime {
	root: string;
	binDir: string;
	node: string;
	npmCli: string;
}

/** Canonical descendants only; the installation root itself remains caller-selected. */
function bundledPath(root: string, ...components: string[]): string {
	const path = resolve(root, ...components);
	if (!path.startsWith(root + sep) || realpathSync(path) !== path) throw new Error("Invalid bundled path");
	return path;
}

/** Inspect and read the same regular file, without following a replaced final symlink. */
function readBundledJson(root: string, ...components: string[]): unknown {
	const fd = openSync(
		bundledPath(root, ...components),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > 64 * 1024) throw new Error("Invalid bundled JSON file");
		return JSON.parse(readFileSync(fd, "utf-8"));
	} finally {
		closeSync(fd);
	}
}

/**
 * Distribution contract: <payload>/{bin/diffex,runtime/bin/node,
 * runtime/lib/node_modules/npm/bin/npm-cli.js,app/node_modules/@diffexai/diffex}.
 * Resolve the package physically first, so aliases (including Homebrew opt links)
 * work, but individual payload components cannot escape through symlinks.
 */
export function getBundledRuntime(packageDir: string): BundledRuntime | undefined {
	try {
		const physicalPackageDir = realpathSync(packageDir);
		const root = resolve(physicalPackageDir, "../../../..");
		if (physicalPackageDir !== join(root, "app", "node_modules", "@diffexai", "diffex")) return undefined;
		const binDir = bundledPath(root, "runtime", "bin");
		const node = bundledPath(root, "runtime", "bin", "node");
		const npmCli = bundledPath(root, "runtime", "lib", "node_modules", "npm", "bin", "npm-cli.js");
		for (const dir of [bundledPath(root, "bin"), bundledPath(root, "runtime"), bundledPath(root, "app"), binDir]) {
			if (!statSync(dir).isDirectory()) return undefined;
		}
		for (const file of [
			node,
			npmCli,
			bundledPath(root, "bin", "diffex"),
			bundledPath(root, "app", "node_modules", "@diffexai", "diffex", "package.json"),
			bundledPath(root, "app", "node_modules", "@diffexai", "diffex", "dist", "cli.js"),
		]) {
			if (!statSync(file).isFile()) return undefined;
		}
		accessSync(node, constants.X_OK);
		accessSync(bundledPath(root, "bin", "diffex"), constants.X_OK);
		const manifest = readBundledJson(root, "app", "node_modules", "@diffexai", "diffex", "package.json");
		if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== "@diffexai/diffex")
			return undefined;
		return { root, binDir, node, npmCli };
	} catch {
		return undefined;
	}
}

/** Homebrew owns only an external marker; it never modifies the signed payload. */
export function isHomebrewInstall(packageDir: string): boolean {
	const runtime = getBundledRuntime(packageDir);
	if (!runtime) return false;
	try {
		if (basename(dirname(runtime.root)) !== "libexec" || basename(runtime.root) !== "diffex") return false;
		const marker = readBundledJson(dirname(runtime.root), ".diffex-homebrew.json");
		if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
		const fields = marker as Record<string, unknown>;
		return (
			fields.schemaVersion === 1 && fields.package === "@diffexai/diffex" && fields.formula === "diffexai/tap/diffex"
		);
	} catch {
		return false;
	}
}

/** Preserve the caller environment without modifying process.env. */
export function withBundledRuntimePath(env: NodeJS.ProcessEnv, packageDir: string): NodeJS.ProcessEnv {
	const runtime = getBundledRuntime(packageDir);
	if (!runtime) return env;
	const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	return { ...env, [pathKey]: [runtime.binDir, env[pathKey]].filter(Boolean).join(delimiter) };
}
