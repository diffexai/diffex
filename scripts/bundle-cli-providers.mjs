import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transformSync } from "esbuild";
import { cliDistribution, cliProviderBundles } from "./cli-distribution.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const packageName = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Unexpected link in provider payload: ${path}`);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

// Kept async in a separate process so the existing synchronous npm packing API
// does not change. Nothing is bundled in the private workspace build output.
export async function bundleCliProviders(root, stage) {
	root = resolve(root);
	stage = resolve(stage);
	const { manifest, bundled } = cliDistribution(root);
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	const results = [];
	for (const bundle of cliProviderBundles) {
		const workspace = bundled.find((pkg) => pkg.manifest.name === bundle.workspace);
		if (!workspace) throw new Error(`Missing provider workspace: ${bundle.workspace}`);
		const source = resolve(workspace.directory, bundle.entry);
		const prefix = `dist/node_modules/${bundle.workspace}`;
		const entryPath = `${prefix}/${bundle.entry}`;
		const target = join(stage, entryPath);
		const original = readFileSync(source, "utf8");
		if (readFileSync(target, "utf8") !== original) throw new Error(`Provider staging input differs: ${entryPath}`);
		// Fail closed if a future provider/declaration/dynamic resolver adds another
		// use of the registry dependency that this single bundle cannot satisfy.
		for (const file of walk(join(stage, "dist"))) {
			if (file === target || (!file.endsWith(".js") && !file.endsWith(".d.ts"))) continue;
			if (new RegExp(`["']${bundle.dependency.replaceAll("/", "\\/")}(?:[\/"'])`).test(readFileSync(file, "utf8")))
				throw new Error(`Unbundled provider dependency reference: ${relative(stage, file)}`);
		}
		const packages = new Map();
		const inputs = new Map();
		function owner(file) {
			let directory = dirname(file);
			while (!existsSync(join(directory, "package.json")) || !JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name) {
				const parent = dirname(directory);
				if (parent === directory) throw new Error(`Provider input has no npm owner: ${file}`);
				directory = parent;
			}
			if (!packages.has(directory)) {
				const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
				const approved = bundle.inputs[metadata.name];
				if (!approved || metadata.version !== approved.version || metadata.license !== approved.license)
					throw new Error(`Unreviewed provider bundle input: ${metadata.name}@${metadata.version}`);
				const locked = lock.packages[relative(root, directory).replaceAll("\\", "/")];
				if (locked?.version !== metadata.version || locked.license !== metadata.license || !locked.integrity || !locked.resolved)
					throw new Error(`Provider npm input differs from lock metadata: ${metadata.name}`);
				const documents = readdirSync(directory).filter((name) => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name)).sort();
				if (!documents.some((name) => /^(?:licen[cs]e|copying)(?:[.-].*)?$/i.test(name)))
					throw new Error(`Missing provider license text: ${metadata.name}`);
				const notices = documents.map((name) => {
					const text = readFileSync(join(directory, name), "utf8");
					if (!text.trim()) throw new Error(`Empty provider legal document: ${metadata.name}/${name}`);
					return { name, text, sha256: sha256(text) };
				});
				if (metadata.name === bundle.dependency)
					for (const [name, spec] of Object.entries(bundle.optionalPeers))
						if (metadata.peerDependencies?.[name] !== spec || metadata.peerDependenciesMeta?.[name]?.optional !== true)
							throw new Error(`Provider optional peer needs review: ${name}`);
				packages.set(directory, { directory, metadata, locked, notices, inputs: [] });
			}
			return packages.get(directory);
		}
		const result = await build({
			absWorkingDir: root,
			entryPoints: [source],
			outfile: target,
			bundle: true,
			preserveSymlinks: true,
			platform: "node",
			format: "esm",
			target: "node22.19",
			write: false,
			metafile: true,
			sourcemap: false,
			sourcesContent: false,
			minify: false,
			keepNames: true,
			legalComments: "inline",
			logLevel: "silent",
			tsconfigRaw: {},
			banner: { js: "// Diffex npm distribution: this file includes mechanically bundled Mistral SDK code.\n// Modified by esbuild bundling; complete original license/NOTICE texts are in THIRD-PARTY-NOTICES.txt." },
			plugins: [{
				name: "reviewed-provider-inputs",
				setup(builder) {
					builder.onResolve({ filter: /.*/ }, async (args) => {
						if (args.pluginData?.resolving) return;
						if (args.kind === "entry-point") return { path: `${bundle.workspace}/${bundle.entry}`, namespace: "reviewed-provider", pluginData: { file: source } };
						if (args.pluginData?.file === source && args.path.startsWith(".")) return { path: args.path, external: true };
						if (builtins.has(args.path)) return { path: args.path, external: true };
						if (!args.path.startsWith(".") && !bundle.inputs[packageName(args.path)]) {
							const name = packageName(args.path);
							if (!manifest.dependencies[name] && !bundle.optionalPeers[name]) throw new Error(`Missing external provider dependency: ${args.path}`);
							return { path: args.path, external: true };
						}
						const resolved = await builder.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, pluginData: { resolving: true } });
						if (resolved.errors.length) return { errors: resolved.errors };
						const pkg = owner(resolved.path);
						return { path: `${pkg.metadata.name}/${relative(pkg.directory, resolved.path).replaceAll("\\", "/")}`, namespace: "reviewed-provider", pluginData: { file: resolved.path } };
					});
					builder.onLoad({ filter: /.*/, namespace: "reviewed-provider" }, (args) => {
						const file = args.pluginData.file;
						if (file === source) return { contents: original, loader: "js", resolveDir: dirname(source), pluginData: args.pluginData };
						if (!/\.(?:[cm]?js|json)$/.test(file)) throw new Error(`Non-JavaScript provider input: ${file}`);
						const pkg = owner(file);
						const bytes = readFileSync(file);
						const inspected = transformSync(bytes.toString(), { loader: file.endsWith(".json") ? "json" : "js", legalComments: "none", minifyWhitespace: true }).code;
						if (/\bimport\.meta\b|\b__dirname\b|\b__filename\b|\brequire\s*\(/.test(inspected))
							throw new Error(`Location-sensitive provider input needs review: ${args.path}`);
						if (/\bimport\s*\(\s*(?!["'\s])/.test(inspected) && bundle.dynamicInputs[`${pkg.metadata.name}/${relative(pkg.directory, file).replaceAll("\\", "/")}`] !== sha256(bytes))
							throw new Error(`Dynamic provider input needs review: ${args.path}`);
						inputs.set(`reviewed-provider:${args.path}`, { pkg, path: relative(pkg.directory, file).replaceAll("\\", "/"), sha256: sha256(bytes) });
						return { contents: bytes, loader: file.endsWith(".json") ? "json" : "js", resolveDir: dirname(file), pluginData: args.pluginData };
					});
				},
			}],
		});
		if (result.warnings.length) throw new Error(`Provider bundling warnings: ${result.warnings.map((item) => item.text).join("; ")}`);
		if (result.outputFiles.length !== 1) throw new Error("Unexpected provider bundle output files");
		const output = Object.values(result.metafile.outputs)[0];
		for (const imported of output.imports) {
			if (!imported.external || (!imported.path.startsWith(".") && !builtins.has(imported.path) && !manifest.dependencies[packageName(imported.path)] && !bundle.optionalPeers[packageName(imported.path)]))
				throw new Error(`Unresolved provider bundle import: ${imported.path}`);
			if (imported.path.startsWith(".") && !existsSync(resolve(dirname(target), imported.path)))
				throw new Error(`Missing staged provider import: ${imported.path}`);
		}
		for (const [input, contribution] of Object.entries(output.inputs)) {
			if (input === `reviewed-provider:${bundle.workspace}/${bundle.entry}` || contribution.bytesInOutput === 0) continue;
			const recorded = inputs.get(input);
			if (!recorded) throw new Error(`Uninventoried provider bundle input: ${input}`);
			recorded.pkg.inputs.push({ path: recorded.path, sha256: recorded.sha256 });
		}
		const components = [];
		let notices = "";
		for (const pkg of [...packages.values()].filter((pkg) => pkg.inputs.length).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
			for (const document of pkg.notices)
				notices += `\n===== ${pkg.metadata.name}@${pkg.metadata.version} (${pkg.metadata.license}) / ${document.name} =====\n${document.text}\n`;
			components.push({
				name: pkg.metadata.name,
				version: pkg.metadata.version,
				license: pkg.metadata.license,
				distribution: "bundled pure JavaScript; not fetched separately for this provider",
				portions: entryPath,
				resolved: pkg.locked.resolved,
				integrity: pkg.locked.integrity,
				notice: "THIRD-PARTY-NOTICES.txt",
				legalDocuments: pkg.notices.map(({ name, sha256 }) => ({ path: name, sha256 })),
				inputs: pkg.inputs.sort((a, b) => a.path.localeCompare(b.path)),
			});
		}
		if (!components.some((component) => component.name === bundle.dependency)) throw new Error(`Provider dependency was not bundled: ${bundle.dependency}`);
		writeFileSync(target, result.outputFiles[0].contents);
		results.push({ prefix, entryPath, dependency: bundle.dependency, components, notices });
	}
	return results;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const results = await bundleCliProviders(process.cwd(), process.argv[2]);
	process.stdout.write(JSON.stringify(results));
}
