import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

export const HOMEBREW_UPDATE_COMMAND = "brew upgrade diffexai/tap/diffex";

export interface BundledRuntime {
	root: string;
	binDir: string;
	node: string;
	npmCli: string;
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
		const binDir = join(root, "runtime", "bin");
		const node = join(binDir, "node");
		const npmCli = join(root, "runtime", "lib", "node_modules", "npm", "bin", "npm-cli.js");
		for (const dir of [join(root, "bin"), join(root, "runtime"), join(root, "app"), binDir]) {
			if (!statSync(dir).isDirectory() || realpathSync(dir) !== dir) return undefined;
		}
		for (const file of [
			node,
			npmCli,
			join(root, "bin", "diffex"),
			join(physicalPackageDir, "package.json"),
			join(physicalPackageDir, "dist", "cli.js"),
		]) {
			if (!statSync(file).isFile() || realpathSync(file) !== file) return undefined;
		}
		accessSync(node, constants.X_OK);
		accessSync(join(root, "bin", "diffex"), constants.X_OK);
		const manifest = JSON.parse(readFileSync(join(physicalPackageDir, "package.json"), "utf-8")) as {
			name?: unknown;
		};
		if (manifest.name !== "@diffexai/diffex") return undefined;
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
		const markerPath = join(dirname(runtime.root), ".diffex-homebrew.json");
		if (!lstatSync(markerPath).isFile() || realpathSync(markerPath) !== markerPath) return false;
		const marker: unknown = JSON.parse(readFileSync(markerPath, "utf-8"));
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
