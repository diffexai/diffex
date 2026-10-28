import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export const distributionDocs = JSON.parse(
	readFileSync(fileURLToPath(new URL("./distribution-docs.json", import.meta.url)), "utf8"),
);

// Only this provider implementation absorbs npm code. All other runtime modules,
// declarations, extension resolution and native/WASM dependencies remain intact.
export const cliProviderBundles = [
	{
		dependency: "@mistralai/mistralai",
		version: "3.2.0",
		workspace: "@diffexai/diffex-ai",
		entry: "dist/api/mistral-conversations.js",
		inputs: {
			"@mistralai/mistralai": { version: "3.2.0", license: "Apache-2.0" },
			zod: { version: "4.6.6", license: "MIT" },
			"zod-to-json-schema": { version: "3.25.2", license: "ISC" },
			"@opentelemetry/semantic-conventions": { version: "1.41.1", license: "Apache-2.0" },
		},
		// Mistral's tracing hook deliberately loads these optional peers dynamically.
		// Keep them external, optional, and discoverable from the installed CLI.
		optionalPeers: {
			"@opentelemetry/sdk-trace-base": "^2.9.0",
			"@opentelemetry/exporter-trace-otlp-http": "^0.220.0",
			"@opentelemetry/resources": "^2.9.0",
		},
		dynamicInputs: {
			"@mistralai/mistralai/esm/extra/observability/telemetry.js": "67c630b221e671eaa6816dd7d30f2d2e51ef9a35197e8a62a0c44a66e983a739",
		},
	},
];

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
	for (const bundle of cliProviderBundles) {
		if (dependencies[bundle.dependency] !== bundle.version)
			throw new Error(`Bundled provider version needs review: ${bundle.dependency}`);
		if (JSON.stringify(policy.bundledNpmDependencies?.[bundle.dependency]) !== JSON.stringify(bundle.inputs))
			throw new Error(`Bundled npm inputs differ from the approved disclosure policy: ${bundle.dependency}`);
		delete dependencies[bundle.dependency];
	}
	for (const name of Object.keys(dependencies)) delete optionalDependencies[name];
	const manifest = structuredClone(cli.manifest);
	manifest.homepage = "https://diffex.ai/";
	manifest.diffexConfig = { ...manifest.diffexConfig, production: true };
	delete manifest.repository;
	delete manifest.bugs;
	manifest.files = [
		"dist",
		...distributionDocs,
		"README.md",
		"CHANGELOG.md",
		"npm-shrinkwrap.json",
		"LICENSE",
		"THIRD-PARTY-NOTICES.txt",
		"distribution-components.json",
		"distribution-files.json",
		"release",
	];
	for (const bundle of cliProviderBundles) {
		for (const [name, spec] of Object.entries(bundle.optionalPeers)) {
			manifest.peerDependencies = { ...manifest.peerDependencies, [name]: spec };
			manifest.peerDependenciesMeta = { ...manifest.peerDependenciesMeta, [name]: { optional: true } };
		}
	}
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
