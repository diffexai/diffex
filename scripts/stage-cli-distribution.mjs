import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cliDistribution } from "./cli-distribution.mjs";
import { preparePackageDistribution } from "./prepare-distribution.mjs";

export function stageCliDistribution(directory, stage) {
	const { manifest, bundled } = cliDistribution();
	mkdirSync(stage, { recursive: true });
	const notices = [
		"LICENSE",
		"THIRD-PARTY-NOTICES.txt",
		"distribution-components.json",
		"distribution-files.json",
	];
	for (const file of manifest.files) cpSync(join(directory, file), join(stage, file), { recursive: true });
	writeFileSync(join(stage, "README.md"), "");
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
	inventory.files.sort((a, b) => a.path.localeCompare(b.path));
	writeFileSync(join(stage, "distribution-files.json"), JSON.stringify(inventory, null, 2) + "\n");
	writeFileSync(join(stage, "distribution-components.json"), JSON.stringify(components, null, 2) + "\n");
	writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	return manifest;
}
