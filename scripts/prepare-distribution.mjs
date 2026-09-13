import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { createDistributionManifest } from "./release-distribution-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECT_CHANGELOGS = [
	"agent",
	"ai",
	"client",
	"coding-agent",
	"protocol",
	"server",
	"session-backends/sqlite-node",
	"telemetry",
	"tui",
].map((name) => `packages/${name}/CHANGELOG.md`);

export function assertChangelogsReady() {
	for (const file of PROJECT_CHANGELOGS) {
		const content = readFileSync(join(root, file), "utf8");
		if (
			!/^# Changelog\s*$/m.test(content) ||
			!/^## \[(?:Unreleased|\d+\.\d+\.\d+)\]/m.test(content) ||
			!/^- \S/m.test(content)
		) {
			throw new Error(`${file}: owner /cl regeneration is required before packaging`);
		}
	}
}

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Unexpected link in generated payload: ${file}`);
		return entry.isDirectory() ? walk(file) : [file];
	});
}

export function preparePackageDistribution(directory) {
	const absolute = resolve(root, directory);
	const pkg = JSON.parse(readFileSync(join(absolute, "package.json"), "utf8"));
	if (pkg.license !== "Apache-2.0") throw new Error(`Unapproved package license: ${pkg.name}`);
	const commit =
		process.env.DIFFEX_SOURCE_COMMIT ??
		execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid private source commit");
	const debug = join(root, ".artifacts/private-debug", commit, pkg.name.replaceAll("/", "-"));
	const components = [
		{
			name: pkg.name,
			version: pkg.version,
			sourceCommit: commit,
			license: "Apache-2.0",
			portions: "Diffex contributions; Pi-derived portions retain MIT terms in LICENSE",
			notice: "LICENSE",
		},
	];
	const notice =
		"Diffex\nCopyright 2026 Luntraa, Inc.\n\nWhere this distribution contains Pi Agent Harness-derived portions,\nthose portions retain their MIT terms and copyright notice in LICENSE.\nThe Apache-2.0 package declaration does not replace third-party terms.\n";
	let notices = notice;
	if (pkg.name === "@diffexai/diffex") {
		for (const workspace of ["evolution", "harness-trace"]) {
			components.push({
				name: `@diffexai/diffex-${workspace}`,
				version: pkg.version,
				license: "Apache-2.0",
				portions: `dist/vendor/${workspace}: runtime JavaScript and declarations`,
				notice: "LICENSE",
			});
		}
		for (const [name, version, license, file] of [
			["highlight.js", "11.9.0", "BSD-3-Clause", "legal/upstream/highlight-11.9.0.LICENSE"],
			["marked", "18.0.5", "MIT", "node_modules/marked/LICENSE"],
		]) {
			const text = readFileSync(join(root, file), "utf8");
			notices += `\n===== ${name}@${version} (${license}) =====\n${text}\n`;
			components.push({
				name,
				version,
				license,
				portions: "HTML exporter vendored JavaScript",
				notice: "THIRD-PARTY-NOTICES.txt",
				noticeTextSha256: createHash("sha256").update(text).digest("hex"),
			});
		}
	}
	for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
		components.push({
			name,
			version,
			distribution: "resolved separately by package manager; not bundled in this npm tarball",
		});
	}
	cpSync(join(root, "LICENSE"), join(absolute, "LICENSE"));
	rmSync(join(absolute, "NOTICE"), { force: true });
	writeFileSync(join(absolute, "THIRD-PARTY-NOTICES.txt"), notices);
	for (const component of components) {
		if (component.notice)
			component.noticeSha256 = createHash("sha256")
				.update(readFileSync(join(absolute, component.notice)))
				.digest("hex");
	}
	writeFileSync(join(absolute, "distribution-components.json"), `${JSON.stringify(components, null, 2)}\n`);
	const dist = join(absolute, "dist");
	if (!existsSync(dist)) throw new Error(`Build output is missing: ${directory}/dist`);
	const inventory = [];
	const allowedSources = new Map();
	for (const source of walk(join(absolute, "src"))) {
		const local = relative(join(absolute, "src"), source).replaceAll("\\", "/");
		if (local.endsWith(".ts") && !local.endsWith(".d.ts")) {
			allowedSources.set(`dist/${local.slice(0, -3)}.js`, source);
			allowedSources.set(`dist/${local.slice(0, -3)}.d.ts`, source);
		} else if (!local.endsWith(".ts")) allowedSources.set(`dist/${local}`, source);
	}
	if (pkg.name === "@diffexai/diffex") {
		for (const workspace of ["evolution", "harness-trace"]) {
			const sourceRoot = join(root, "packages", workspace, "src");
			for (const source of walk(sourceRoot)) {
				const local = relative(sourceRoot, source).replaceAll("\\", "/");
				if (!local.endsWith(".ts") || local.endsWith(".d.ts")) continue;
				for (const extension of [".js", ".d.ts"])
					allowedSources.set(`dist/vendor/${workspace}/${local.slice(0, -3)}${extension}`, source);
			}
		}
	}
	for (const file of walk(dist)) {
		const local = relative(absolute, file).replaceAll("\\", "/");
		if (file.endsWith(".map")) {
			const target = join(debug, local);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(file, target);
			rmSync(file);
			continue;
		}
		if (file.endsWith(".js") || file.endsWith(".d.ts")) {
			const text = readFileSync(file, "utf8");
			const filtered = text.replace(/^[\t ]*\/\/[#@]\s*sourceMappingURL=[^\r\n]*(?:\r?\n|$)/gm, "");
			if (filtered !== text) writeFileSync(file, filtered);
		}
		if (!allowedSources.has(local)) throw new Error(`Build payload has no approved source input: ${local}`);
		inventory.push({ path: local, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
	}
	if (pkg.name === "@diffexai/diffex-tui") {
		for (const platform of ["darwin", "win32"]) {
			for (const file of walk(join(absolute, "native", platform, "prebuilds"))) {
				if (!file.endsWith(".node")) throw new Error(`Unexpected native build payload: ${file}`);
				inventory.push({
					path: relative(absolute, file).replaceAll("\\", "/"),
					sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
				});
			}
		}
	}
	const sortedInventory = inventory.sort((a, b) => a.path.localeCompare(b.path));
	writeFileSync(
		join(absolute, "distribution-files.json"),
		`${JSON.stringify({ sourceCommit: commit, algorithm: "sha256", files: sortedInventory }, null, 2)}\n`,
	);
	if (pkg.name === "@diffexai/diffex") {
		const release = join(absolute, "release");
		mkdirSync(release, { recursive: true });
		const policy = JSON.parse(readFileSync(join(root, "docs/release/distribution-policy.json"), "utf8"));
		if (policy.status !== "approved" || policy.publicHosting !== "npmjs" || policy.channels.standalone !== "defer")
			throw new Error("Unapproved distribution policy");
		const manifest = createDistributionManifest({
			packages: getPublicWorkspacePackages(),
			sourceCommit: commit,
			policy,
		});
		writeFileSync(join(release, "distribution-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		cpSync(join(absolute, "install-lock/package.json"), join(release, "install-package.json"));
		cpSync(join(absolute, "install-lock/package-lock.json"), join(release, "install-package-lock.json"));
	}
	return { name: pkg.name, files: sortedInventory };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.chdir(root);
	assertChangelogsReady();
	const packages = process.argv[2] ? [{ directory: process.argv[2] }] : getPublicWorkspacePackages();
	const inventories = packages.map((pkg) => preparePackageDistribution(pkg.directory));
	mkdirSync(join(root, ".artifacts"), { recursive: true });
	writeFileSync(join(root, ".artifacts/distribution-files.json"), `${JSON.stringify(inventories, null, 2)}\n`);
}
