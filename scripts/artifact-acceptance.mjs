import { ACCEPTANCE_MANAGERS, assertContained, installConsumer, isolatedEnvironment, verifyTarballs } from "./artifact-installation.mjs";
export { assertContained, installConsumer, isolatedEnvironment, verifyTarballs } from "./artifact-installation.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliDistribution } from "./cli-distribution.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function candidateInstallationOptions(manager) {
	assert(ACCEPTANCE_MANAGERS.includes(manager), "Unsupported package manager");
	return { lifecycleScripts: manager === "npm" ? "enabled" : "disabled" };
}

export function packageClosure(name, packages) {
	const result = [];
	const visiting = new Set();
	const visited = new Set();
	function visit(current) {
		if (visited.has(current)) return;
		assert(!visiting.has(current), `Public dependency cycle: ${current}`);
		const pkg = packages.find((candidate) => candidate.name === current);
		assert(pkg, `Missing local public dependency: ${current}`);
		visiting.add(current);
		for (const dependency of Object.keys({
			...pkg.dependencies,
			...pkg.optionalDependencies,
			...pkg.peerDependencies,
		})) {
			if (dependency.startsWith("@diffexai/")) visit(dependency);
		}
		visiting.delete(current);
		visited.add(current);
		result.push(pkg);
	}
	visit(name);
	return result;
}

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

export function declaredEntrypoints(pkg, directory) {
	const files = walk(directory).map((file) => relative(directory, file).replaceAll("\\", "/"));
	const imports = [];
	function target(value, specifier, condition) {
		if (typeof value === "string") {
			const pattern = value.replace(/^\.\//, "");
			const [prefix, suffix] = pattern.split("*");
			const matches = pattern.includes("*")
				? files.filter((file) => file.startsWith(prefix) && file.endsWith(suffix))
				: [pattern];
			assert(matches.length, `Empty export pattern: ${pkg.name} ${value}`);
			for (const file of matches) {
				assertContained(join(directory, file), directory);
				if (condition !== "types" && /\.[cm]?js$/.test(file)) {
					imports.push(specifier.replace("*", file.slice(prefix.length, suffix ? -suffix.length : undefined)));
				}
			}
		} else if (value && typeof value === "object") {
			for (const [key, nested] of Object.entries(value)) target(nested, specifier, key);
		}
	}
	if (pkg.exports) {
		for (const [key, value] of Object.entries(pkg.exports))
			target(value, key === "." ? pkg.name : pkg.name + key.slice(1));
	} else target(pkg.main, pkg.name);
	for (const file of [pkg.main, pkg.types, ...Object.values(pkg.bin ?? {})].filter(Boolean))
		assertContained(join(directory, file), directory);
	return [...new Set(imports)];
}

export const operations = {
	"@diffexai/diffex-agent-core": `const agent = new api.Agent({ streamFn: () => { throw new Error("Unexpected inference"); } }); agent.state.systemPrompt = "artifact"; assert.equal(agent.state.systemPrompt, "artifact");`,
	"@diffexai/diffex-ai": `const stream = api.createAssistantMessageEventStream(); stream.end({ marker: "artifact" }); assert.equal((await stream.result()).marker, "artifact");`,
	"@diffexai/diffex-client": `const client = new api.DiffexClient({ transportFactory: async () => { throw new Error("Unexpected transport"); } }); await client.dispose(); assert.equal(client.disposed, true);`,
	"@diffexai/diffex-protocol": `assert.deepEqual(api.decodeCbor(api.encodeCbor({ artifact: 42 })), { artifact: 42 });`,
	"@diffexai/diffex-harness-state": `const store = new api.HarnessStateStore(process.env.DIFFEX_CODING_AGENT_DIR); const state = await store.initialize(); assert.equal((await store.loadCurrent()).manifest.version, state.manifest.version);`,
	"@diffexai/diffex-telemetry": `let called = false; await api.NOOP_TELEMETRY_CONTEXT.startSpan({ name: "artifact" }, () => { called = true; }); assert(called);`,
	"@diffexai/diffex-session-backend-sqlite-node": `const db = await api.createNodeSqliteFactory().open(":memory:"); try { db.exec("CREATE TABLE acceptance (value TEXT)"); db.prepare("INSERT INTO acceptance VALUES (?)").run("artifact"); assert.equal(db.prepare("SELECT value FROM acceptance").get().value, "artifact"); } finally { db.close(); }`,
	"@diffexai/diffex-tui": `assert(new api.Text("artifact", 0, 0).render(40).join("\\n").includes("artifact")); if (process.platform === "darwin" || process.platform === "win32") { const platform = process.platform; const filename = platform === "darwin" ? "darwin-modifiers.node" : "win32-console-mode.node"; const helper = require(path.join(packageRoot, "native", platform, "prebuilds", platform + "-" + process.arch, filename)); assert.equal(typeof helper.isModifierPressed, "function"); }`,
	"@diffexai/diffex": `const runtime = await api.ModelRuntime.create({ authPath: path.join(process.env.DIFFEX_CODING_AGENT_DIR, "auth.json"), modelsPath: path.join(process.env.DIFFEX_CODING_AGENT_DIR, "models.json"), refreshOnCreate: false }); assert(runtime); const cliRequire = createRequire(path.join(packageRoot, "package.json")); const clipboard = cliRequire("@mariozechner/clipboard"); assert.equal(typeof clipboard.getText, "function"); const photon = cliRequire("@silvia-odwyer/photon-node"); const image = new photon.PhotonImage(new Uint8Array([0, 0, 0, 255]), 1, 1); assert.equal(image.get_width(), 1); image.free();
 const sm = api.SessionManager.create(process.cwd(), path.join(process.env.DIFFEX_CODING_AGENT_DIR, "export-session"));
 sm.appendMessage({ role: "user", content: "artifact export", timestamp: Date.now() });
 sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "artifact exported reply" }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
 const html = path.join(process.cwd(), "artifact export.html");
 execFileSync(process.execPath, [path.join(packageRoot, "dist/cli.js"), "--export", sm.getSessionFile(), html], { env: process.env, timeout: 30000 });
 const exported = readFileSync(html, "utf8"); const embedded = exported.match(/<script id="session-data"[^>]*>([^<]+)/); assert(embedded); const sessionData = JSON.parse(Buffer.from(embedded[1], "base64").toString("utf8")); assert(sessionData.entries.some((entry) => entry.message?.content?.some?.((part) => part.text === "artifact exported reply"))); assert(exported.includes("<style>"));`,
	"@diffexai/diffex-server": `const service = new testing.TestServerService(); service.seed("artifact-session", "Artifact"); const server = websocket.createWebSocketServer(service, { host: "127.0.0.1", port: 0 }); await server.start(); assert(server.addresses.length); await server.close();`,
	"@diffexai/diffex-coding-agent-server": `const reporter = api.createDurableUsageReporter({ endpoint: "http://127.0.0.1:1/usage", sharedSecret: "local-artifact-fixture-only-32-bytes", outboxDirectory: path.join(process.env.DIFFEX_CODING_AGENT_DIR, "outbox"), fetch: () => { throw new Error("Unexpected usage"); } }); await reporter.close();`,
};

export function acceptArtifacts(artifactDirectory, outputDirectory, { managers = ACCEPTANCE_MANAGERS } = {}) {
	assert(
		managers.length && managers.every((manager) => ACCEPTANCE_MANAGERS.includes(manager)),
		"Expected npm, pnpm or Bun acceptance",
	);
	const packages = getPublicWorkspacePackages().map((pkg) => ({
		...cliDistribution(root).manifest,
		directory: pkg.directory,
	}));
	const raw = readJson(join(artifactDirectory, "manifest.json"));
	const records = Array.isArray(raw) ? raw : raw.packages;
	const tarballDirectory = Array.isArray(raw) ? join(artifactDirectory, "tarballs") : artifactDirectory;
	verifyTarballs(tarballDirectory, records, packages);
	mkdirSync(outputDirectory, { recursive: true });
	const temporary = mkdtempSync(join(tmpdir(), "diffex artifact acceptance "));
	const evidence = {
		sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		packages: [],
		artifacts: records,
		realProvider: "Not configured; controlled fixtures only",
		cleanup: false,
		status: "failed",
		processes: [],
	};
	try {
		for (const manager of managers) {
			const installationOptions = candidateInstallationOptions(manager);
			const cacheDirectory = join(temporary, manager, "registry-cache");
			for (const pkg of packages) {
				assert(operations[pkg.name], `Missing representative operation: ${pkg.name}`);
				const consumer = join(temporary, manager, pkg.name.split("/").pop());
				const selected = packageClosure(pkg.name, packages);
				const env = installConsumer(consumer, manager, selected, records, tarballDirectory,
					manager === "pnpm" ? join(consumer, "cache") : cacheDirectory, installationOptions);
				// createRequire preserves an artificial filename's lexical path; use pnpm's real package root.
				const packageRoot = realpathSync(join(consumer, "node_modules", pkg.name));
				const imports = declaredEntrypoints(pkg, packageRoot);
				const source = [
					`import assert from "node:assert/strict"; import path from "node:path"; import { createRequire } from "node:module"; import { execFileSync } from "node:child_process"; import { readFileSync } from "node:fs";`,
					...imports.map((specifier) => `import ${JSON.stringify(specifier)};`),
					`import * as api from ${JSON.stringify(pkg.name)};`,
					...(pkg.name === "@diffexai/diffex-server"
						? [
								'import * as testing from "@diffexai/diffex-server/testing"; import * as websocket from "@diffexai/diffex-server/websocket";',
							]
						: []),
					`const packageRoot = ${JSON.stringify(packageRoot)}; const require = createRequire(import.meta.url);`,
					operations[pkg.name],
				].join("\n");
				writeFileSync(join(consumer, "operation.mjs"), source);
				cpSync(join(root, "scripts/fixtures/artifact-network-guard.mjs"), join(consumer, "guard.mjs"));
				execFileSync(process.execPath, ["--import", join(consumer, "guard.mjs"), join(consumer, "operation.mjs")], {
					cwd: join(consumer, "project"),
					env,
					stdio: "inherit",
					timeout: 30_000,
				});
				evidence.packages.push({
					manager,
					managerVersion: execFileSync(manager, ["--version"], { cwd: consumer, env, encoding: "utf8" }).trim(),
					lifecycleScripts: installationOptions.lifecycleScripts,
					name: pkg.name,
					version: pkg.version,
					entrypoints: imports,
					operation: "passed",
					localDependencies: selected.map((dependency) => dependency.name),
				});
				console.log(`Accepted ${manager}: ${pkg.name}`);
			}
			const consumer = join(temporary, manager, "process acceptance");
			const env = installConsumer(consumer, manager, packages, records, tarballDirectory,
				manager === "pnpm" ? join(consumer, "cache") : cacheDirectory, installationOptions);
			const project = join(consumer, "project");
			writeFileSync(join(project, "artifact helper.txt"), "artifact-helper-confirmation\n");
			const helperOptions = { cwd: project, env, encoding: "utf8", timeout: 10000 };
			assert(execFileSync("fd", ["artifact", "."], helperOptions).includes("artifact helper.txt"));
			assert(
				execFileSync(
					"rg",
					["--fixed-strings", "artifact-helper-confirmation", "artifact helper.txt"],
					helperOptions,
				).includes("artifact-helper-confirmation"),
			);
			const helpers = Object.fromEntries(
				["fd", "rg"].map((tool) => [tool, execFileSync(tool, ["--version"], helperOptions).trim()]),
			);
			cpSync(join(root, "scripts/fixtures/artifact-network-guard.mjs"), join(consumer, "guard.mjs"));
			const layout = join(temporary, manager, "terminal");
			mkdirSync(layout);
			// The terminal harness accepts explicit consumer paths, avoiding workspace resolution.
			try {
				execFileSync("python3", [join(root, "scripts/verify-candidate-artifacts.py"), layout, consumer], {
					env,
					cwd: consumer,
					stdio: "inherit",
					timeout: 90_000,
				});
			} finally {
				cpSync(layout, join(outputDirectory, manager), { recursive: true });
			}
			evidence.processes.push({
				manager,
				lifecycleScripts: installationOptions.lifecycleScripts,
				server: "Excluded from CLI distribution; hosted runtime remains private",
				terminal: "passed",
				helpers,
			});
		}
		const cli = records.find((record) => record.name === "@diffexai/diffex");
		execFileSync(
			process.execPath,
			[
				join(root, "scripts/npm-lifecycle.mjs"),
				join(tarballDirectory, cli.filename),
				outputDirectory,
				...(managers.includes("bun") ? [] : ["--skip-bun"]),
				...(managers.includes("pnpm") ? [] : ["--skip-pnpm"]),
			],
			{ cwd: root, stdio: "inherit", timeout: 3_600_000 },
		);
		verifyTarballs(tarballDirectory, records, packages);
		writeFileSync(
			join(outputDirectory, "SHA256SUMS"),
			records.map((record) => `${record.sha256}  ${record.filename}\n`).join(""),
		);
		evidence.status = "passed";
	} finally {
		rmSync(temporary, { recursive: true, force: true });
		evidence.cleanup = !existsSync(temporary);
		writeFileSync(join(outputDirectory, "acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`);
	}
	return evidence;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [directory, output] = process.argv.slice(2);
	assert(directory && output, "Usage: node scripts/artifact-acceptance.mjs ARTIFACT_DIRECTORY EVIDENCE_DIRECTORY");
	acceptArtifacts(resolve(directory), resolve(output));
}
