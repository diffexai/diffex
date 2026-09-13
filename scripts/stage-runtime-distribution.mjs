import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distributionDocs } from "./cli-distribution.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { preparePackageDistribution } from "./prepare-distribution.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? "");
if (!process.argv[2] || existsSync(output)) throw new Error("Specify a new runtime output directory");
const local = relative(root, output);
if (!local.startsWith("..") && !isAbsolute(local)) throw new Error("Runtime output must be outside the source tree");
process.chdir(root);
const workspaces = new Map(
	findPackageDirectories().map((directory) => {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		return [manifest.name, { directory, manifest }];
	}),
);
const selected = new Map();
function visit(name) {
	if (selected.has(name)) return;
	const pkg = workspaces.get(name);
	if (!pkg) throw new Error(`Missing runtime workspace: ${name}`);
	selected.set(name, pkg);
	for (const dependency of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies }))
		if (dependency.startsWith("@diffexai/")) visit(dependency);
}
visit("@diffexai/diffex-coding-agent-server");
visit("@diffexai/diffex-evolution");
visit("@diffexai/diffex-harness-trace");
mkdirSync(output);
const notices = [
	"LICENSE",
	"NOTICE",
	"THIRD-PARTY-NOTICES.txt",
	"distribution-components.json",
	"distribution-files.json",
];
for (const pkg of selected.values()) {
	const prepared = preparePackageDistribution(pkg.directory);
	const target = join(output, pkg.directory);
	mkdirSync(target, { recursive: true });
	const manifest = structuredClone(pkg.manifest);
	delete manifest.scripts;
	delete manifest.devDependencies;
	writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	const files = [...prepared.files.map((file) => file.path), ...notices];
	if (pkg.manifest.name === "@diffexai/diffex") files.push(...distributionDocs);
	for (const file of files) {
		mkdirSync(dirname(join(target, file)), { recursive: true });
		cpSync(join(pkg.directory, file), join(target, file));
	}
	if (existsSync(join(pkg.directory, "node_modules")))
		cpSync(join(pkg.directory, "node_modules"), join(target, "node_modules"), { recursive: true });
}
cpSync(join(root, "node_modules"), join(output, "node_modules"), {
	recursive: true,
	verbatimSymlinks: true,
	filter(source) {
		if (!lstatSync(source).isSymbolicLink()) return true;
		const resolved = realpathSync(source);
		const workspace = [...workspaces.values()].find(
			(pkg) => resolved === resolve(pkg.directory) || resolved.startsWith(`${resolve(pkg.directory)}/`),
		);
		return !workspace || selected.has(workspace.manifest.name);
	},
});
cpSync(join(root, "LICENSE"), join(output, "LICENSE"));
cpSync(join(output, "packages/coding-agent/THIRD-PARTY-NOTICES.txt"), join(output, "THIRD-PARTY-NOTICES.txt"));
writeFileSync(
	join(output, "README.md"),
	"# Diffex hosted runtime\n\nStart diffex-runtime-server with the session, workspace, internal authentication, model, and usage configuration supplied by your control plane.\nThis image is not an interactive CLI installation channel.\nSee packages/coding-agent/docs for user-facing runtime behavior and LICENSE and THIRD-PARTY-NOTICES.txt for legal terms.\n",
);
writeFileSync(
	join(output, "runtime-distribution.json"),
	`${JSON.stringify({ sourceCommit: process.env.DIFFEX_SOURCE_COMMIT, packages: [...selected.keys()], documentation: distributionDocs }, null, 2)}\n`,
);
console.log(`Prepared ${selected.size} private hosted runtime workspaces`);
