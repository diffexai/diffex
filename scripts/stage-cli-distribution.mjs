import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { cliDistribution } from "./cli-distribution.mjs";
import { preparePackageDistribution } from "./prepare-distribution.mjs";

export function stageCliDistribution(directory, stage) {
	const { manifest, bundled } = cliDistribution();
	mkdirSync(stage, { recursive: true });
	const notices = ["LICENSE", "THIRD-PARTY-NOTICES.txt", "distribution-components.json", "distribution-files.json"];
	for (const file of manifest.files) {
		if (file === "README.md") continue;
		mkdirSync(dirname(join(stage, file)), { recursive: true });
		cpSync(join(directory, file), join(stage, file), { recursive: true });
	}
	writeFileSync(
		join(stage, "README.md"),
		"# Diffex\n\nCoding agent for your terminal.\n\n" +
			"## Requirements\n\nNode.js 22.19.0 or newer. Supports macOS and Linux on arm64 and x64.\n\n" +
			"## Install\n\n```sh\nnpm i -g @diffexai/diffex\n```\n\n" +
			"Or with pnpm:\n\n```sh\npnpm add -g --ignore-scripts @diffexai/diffex\n```\n\n" +
			"## Usage\n\n```sh\ndiffex --version\ndiffex --help\ndiffex\n```\n\n" +
			"Use `/login` in Diffex to connect your provider account.\n\n" +
			"## Update\n\n```sh\ndiffex update --self\n```\n\n" +
			"See the [Diffex website](https://diffex.ai/) for project information.\n\n" +
			"## License\n\nDiffex is licensed under MIT; Pi-derived portions retain their MIT terms.\nSee LICENSE and THIRD-PARTY-NOTICES.txt, including bundled dependency licenses.\n",
	);
	const inventory = JSON.parse(readFileSync(join(directory, "distribution-files.json"), "utf8"));
	const components = JSON.parse(readFileSync(join(directory, "distribution-components.json"), "utf8")).filter(
		(component) => !bundled.some((pkg) => pkg.manifest.name === component.name),
	);
	for (const pkg of bundled) {
		const prepared = preparePackageDistribution(pkg.directory);
		const prefix = `dist/node_modules/${pkg.manifest.name}`;
		const target = join(stage, prefix);
		const metadata = structuredClone(pkg.manifest);
		for (const field of [
			"scripts",
			"devDependencies",
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
			"peerDependenciesMeta",
			"files",
			"repository",
			"bugs",
		])
			delete metadata[field];
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "package.json"), JSON.stringify(metadata, null, 2) + "\n");
		for (const file of [...prepared.files.map((item) => item.path), ...notices]) {
			mkdirSync(join(target, file, ".."), { recursive: true });
			cpSync(join(pkg.directory, file), join(target, file));
		}
		for (const file of ["package.json", ...prepared.files.map((item) => item.path), ...notices])
			inventory.files.push({
				path: `${prefix}/${file}`,
				sha256: createHash("sha256")
					.update(readFileSync(join(target, file)))
					.digest("hex"),
			});
		const notice = `${prefix}/LICENSE`;
		components.push({
			name: pkg.manifest.name,
			version: pkg.manifest.version,
			license: pkg.manifest.license,
			portions: `${prefix}: bundled runtime, declarations, approved assets and native prebuilds`,
			notice,
			noticeSha256: createHash("sha256")
				.update(readFileSync(join(stage, notice)))
				.digest("hex"),
		});
	}
	const providerBundles = JSON.parse(
		execFileSync(process.execPath, [fileURLToPath(new URL("./bundle-cli-providers.mjs", import.meta.url)), stage], {
			encoding: "utf8",
			maxBuffer: 20 * 1024 * 1024,
		}),
	);
	for (const bundle of providerBundles) {
		for (const prefix of ["", bundle.prefix]) {
			const target = join(stage, prefix);
			const componentPath = join(target, "distribution-components.json");
			const localComponents = prefix ? JSON.parse(readFileSync(componentPath, "utf8")) : components;
			const stale = localComponents.findIndex((component) => component.name === bundle.dependency && component.distribution?.startsWith("resolved separately"));
			if (stale !== -1) localComponents.splice(stale, 1);
			writeFileSync(join(target, "THIRD-PARTY-NOTICES.txt"), readFileSync(join(target, "THIRD-PARTY-NOTICES.txt"), "utf8") + bundle.notices);
			localComponents.push(...bundle.components.map((component) => ({
				...component,
				portions: prefix ? component.portions.slice(prefix.length + 1) : component.portions,
			})));
			for (const component of localComponents)
				if (component.notice)
					component.noticeSha256 = createHash("sha256").update(readFileSync(join(target, component.notice))).digest("hex");
			if (prefix) {
				writeFileSync(componentPath, JSON.stringify(localComponents, null, 2) + "\n");
				const localInventory = JSON.parse(readFileSync(join(target, "distribution-files.json"), "utf8"));
				for (const file of localInventory.files)
					file.sha256 = createHash("sha256").update(readFileSync(join(target, file.path))).digest("hex");
				writeFileSync(join(target, "distribution-files.json"), JSON.stringify(localInventory, null, 2) + "\n");
			}
		}
	}
	// Bundling changes a provider implementation and the nested metadata/notices;
	// checksum final staged bytes, never the private workspace build inputs.
	for (const file of inventory.files)
		file.sha256 = createHash("sha256").update(readFileSync(join(stage, file.path))).digest("hex");
	inventory.files.sort((a, b) => a.path.localeCompare(b.path));
	writeFileSync(join(stage, "distribution-files.json"), JSON.stringify(inventory, null, 2) + "\n");
	writeFileSync(join(stage, "distribution-components.json"), JSON.stringify(components, null, 2) + "\n");
	writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	return manifest;
}
