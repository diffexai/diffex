import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function cliDistribution(root = ".") {
	const workspaces = new Map(
		findPackageDirectories(join(root, "packages"))
			.filter((directory) => !directory.endsWith("/install-lock"))
			.map((directory) => {
				const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
				return [manifest.name, { directory, manifest }];
			}),
	);
	const cli = workspaces.get("@diffexai/diffex");
	if (!cli) throw new Error("Missing CLI workspace");
	const bundled = new Map();
	const dependencies = {};
	const optionalDependencies = {};
	function visit(name) {
		if (bundled.has(name)) return;
		const workspace = workspaces.get(name);
		if (!workspace) throw new Error(`Missing internal runtime workspace: ${name}`);
		bundled.set(name, workspace);
		for (const [field, target] of [
			["dependencies", dependencies],
			["optionalDependencies", optionalDependencies],
		]) {
			for (const [dependency, version] of Object.entries(workspace.manifest[field] ?? {})) {
				if (dependency.startsWith("@diffexai/")) visit(dependency);
				else {
					if ((dependencies[dependency] ?? optionalDependencies[dependency] ?? version) !== version)
						throw new Error(`Conflicting bundled runtime dependency: ${dependency}`);
					target[dependency] = version;
				}
			}
		}
	}
	visit(cli.manifest.name);
	visit("@diffexai/diffex-evolution");
	visit("@diffexai/diffex-harness-trace");
	bundled.delete(cli.manifest.name);
	const policy = JSON.parse(readFileSync(join(root, "docs/release/distribution-policy.json"), "utf8"));
	const actual = [...bundled.values()]
		.map((pkg) => relative(join(root, "packages"), pkg.directory).replaceAll("\\", "/"))
		.sort();
	if (
		policy.status !== "approved" ||
		!Array.isArray(policy.bundledWorkspaces) ||
		JSON.stringify([...policy.bundledWorkspaces].sort()) !== JSON.stringify(actual)
	)
		throw new Error("Bundled runtime inventory differs from the approved disclosure policy");
	for (const pkg of bundled.values())
		if (pkg.manifest.version !== cli.manifest.version)
			throw new Error(`Bundled workspace version differs from CLI: ${pkg.manifest.name}`);
	for (const name of Object.keys(dependencies)) delete optionalDependencies[name];
	const manifest = structuredClone(cli.manifest);
	manifest.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
	manifest.optionalDependencies = Object.fromEntries(
		Object.entries(optionalDependencies).sort(([a], [b]) => a.localeCompare(b)),
	);
	bundled.delete("@diffexai/diffex-evolution");
	bundled.delete("@diffexai/diffex-harness-trace");
	delete manifest.devDependencies;
	delete manifest.scripts;
	return { manifest, bundled: [...bundled.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)) };
}
