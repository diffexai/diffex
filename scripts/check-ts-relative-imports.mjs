import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";

const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const files = [];

function collectTypescriptFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectTypescriptFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(join(directory, entry.name));
		}
	}
}

function isRelativeJavaScriptSpecifier(specifier) {
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

function getImportTypeSpecifier(node) {
	if (!ts.isLiteralTypeNode(node.argument)) return undefined;
	if (!ts.isStringLiteralLikeNode(node.argument.literal)) return undefined;
	return node.argument.literal;
}

const failures = [];

collectTypescriptFiles(".");

if (files.length > 0) {
	// TypeScript's native AST API is unstable; the workspace pins its exact version.
	// A standalone project checks every collected file, independent of repository configs.
	const directory = mkdtempSync(join(tmpdir(), "diffex-ts-relative-imports-"));
	let api;
	try {
		const config = join(directory, "tsconfig.json");
		writeFileSync(
			config,
			JSON.stringify({
				compilerOptions: { noResolve: true, noLib: true, types: [] },
				files: files.map((file) => resolve(file)),
			}),
		);
		api = new API();
		const snapshot = await api.updateSnapshot({ openProjects: [config] });
		const project = snapshot.getProject(config);
		if (!project) throw new Error("Could not open the relative import check project");

		for (const file of files.sort()) {
			const sourceFile = await project.program.getSourceFile(resolve(file));
			if (!sourceFile) throw new Error(`Could not parse ${file}`);

			function checkSpecifier(node) {
				if (!isRelativeJavaScriptSpecifier(node.text)) return;
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				failures.push(`${file}:${line + 1}:${character + 1}: ${node.text}`);
			}

			function visit(node) {
				if (ts.isImportDeclaration(node) && ts.isStringLiteralLikeNode(node.moduleSpecifier)) {
					checkSpecifier(node.moduleSpecifier);
				} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLikeNode(node.moduleSpecifier)) {
					checkSpecifier(node.moduleSpecifier);
				} else if (
					ts.isCallExpression(node) &&
					node.expression.kind === ts.SyntaxKind.ImportKeyword &&
					node.arguments[0] &&
					ts.isStringLiteralLikeNode(node.arguments[0])
				) {
					checkSpecifier(node.arguments[0]);
				} else if (ts.isImportTypeNode(node)) {
					const specifier = getImportTypeSpecifier(node);
					if (specifier) checkSpecifier(specifier);
				}

				node.forEachChild(visit);
			}

			visit(sourceFile);
		}
	} finally {
		try {
			// Closing the client also disposes its snapshots and projects.
			await api?.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}

if (failures.length > 0) {
	console.error("Relative .js imports are not allowed in non-declaration .ts files:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exitCode = 1;
}
