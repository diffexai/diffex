import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function assertContained(file, directory) {
	const local = relative(realpathSync(directory), realpathSync(file));
	assert(local === "" || (!local.startsWith("..") && !isAbsolute(local)), `Path escapes isolated consumer: ${file}`);
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

export function verifyTarballs(directory, records, packages) {
	assert.equal(records.length, packages.length, "Incomplete tarball inventory");
	assert.equal(new Set(records.map((pkg) => pkg.name)).size, packages.length, "Duplicate tarball identity");
	for (const pkg of packages) {
		const record = records.find((entry) => entry.name === pkg.name);
		assert(record && record.version === pkg.version, `Missing tarball: ${pkg.name}`);
		assert.equal(record.filename, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
		assert.equal(
			digest(readFileSync(join(directory, record.filename))),
			record.sha256,
			`Tarball checksum mismatch: ${pkg.name}`,
		);
	}
}

export function isolatedEnvironment(directory) {
	const env = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	for (const dir of ["home", "config", "cache", "prefix", "project", "agent", "temp"])
		mkdirSync(join(directory, dir), { recursive: true });
	return {
		...env,
		HOME: join(directory, "home"),
		USERPROFILE: join(directory, "home"),
		XDG_CONFIG_HOME: join(directory, "config"),
		XDG_CACHE_HOME: join(directory, "cache"),
		npm_config_cache: join(directory, "cache", "npm"),
		npm_config_prefix: join(directory, "prefix"),
		npm_config_userconfig: join(directory, "empty.npmrc"),
		npm_config_globalconfig: join(directory, "empty-global.npmrc"),
		npm_config_registry: "https://registry.npmjs.org",
		npm_config_update_notifier: "false",
		BUN_INSTALL_CACHE_DIR: join(directory, "cache", "bun"),
		TMPDIR: join(directory, "temp"),
		TMP: join(directory, "temp"),
		TEMP: join(directory, "temp"),
		DIFFEX_CODING_AGENT_DIR: join(directory, "agent"),
		DIFFEX_NO_LOCAL_LLM: "1",
		DIFFEX_OFFLINE: "1",
		TERM: "xterm-256color",
	};
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

export function installConsumer(directory, manager, selected, records, tarballDirectory) {
	mkdirSync(directory, { recursive: true });
	const env = isolatedEnvironment(directory);
	writeFileSync(join(directory, ".npmrc"), "@diffexai:registry=http://127.0.0.1:9/\n");
	const dependencies = Object.fromEntries(
		selected.map((pkg) => [
			pkg.name,
			`file:${join(tarballDirectory, records.find((record) => record.name === pkg.name).filename)}`,
		]),
	);
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }),
	);
	execFileSync(
		manager,
		manager === "npm"
			? ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
			: ["install", "--production", "--ignore-scripts"],
		{ cwd: directory, env, stdio: "inherit", timeout: 180_000 },
	);
	for (const pkg of selected) {
		const installed = join(directory, "node_modules", pkg.name);
		assertContained(installed, directory);
		const info = readJson(join(installed, "package.json"));
		assert.equal(info.name, pkg.name);
		assert.equal(info.version, pkg.version);
		const record = records.find((entry) => entry.name === pkg.name);
		const inventory = JSON.parse(
			execFileSync("tar", ["-xOf", join(tarballDirectory, record.filename), "package/distribution-files.json"], {
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			}),
		);
		assert.deepEqual(
			readJson(join(installed, "distribution-files.json")),
			inventory,
			"Installed inventory differs from the checked tarball",
		);
		for (const file of inventory.files) {
			assertContained(join(installed, file.path), installed);
			assert.equal(
				digest(readFileSync(join(installed, file.path))),
				file.sha256,
				`Installed bytes differ: ${pkg.name}/${file.path}`,
			);
		}
	}
	return env;
}

export function acceptArtifacts(artifactDirectory, outputDirectory, { managers = ["npm", "bun"] } = {}) {
	assert(
		managers.length && managers.every((manager) => ["npm", "bun"].includes(manager)),
		"Expected npm or Bun acceptance",
	);
	const packages = getPublicWorkspacePackages().map((pkg) => ({
		...readJson(join(root, pkg.directory, "package.json")),
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
			for (const pkg of packages) {
				assert(operations[pkg.name], `Missing representative operation: ${pkg.name}`);
				const consumer = join(temporary, manager, pkg.name.split("/").pop());
				const selected = packageClosure(pkg.name, packages);
				const env = installConsumer(consumer, manager, selected, records, tarballDirectory);
				const packageRoot = join(consumer, "node_modules", pkg.name);
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
					managerVersion: execFileSync(manager, ["--version"], { encoding: "utf8" }).trim(),
					name: pkg.name,
					version: pkg.version,
					entrypoints: imports,
					operation: "passed",
					localDependencies: selected.map((dependency) => dependency.name),
				});
				console.log(`Accepted ${manager}: ${pkg.name}`);
			}
			const consumer = join(temporary, manager, "process acceptance");
			const env = installConsumer(consumer, manager, packages, records, tarballDirectory);
			cpSync(join(root, "scripts/fixtures/artifact-network-guard.mjs"), join(consumer, "guard.mjs"));
			cpSync(join(root, "scripts/fixtures/artifact-server.mjs"), join(consumer, "server-smoke.mjs"));
			execFileSync(process.execPath, ["--import", join(consumer, "guard.mjs"), join(consumer, "server-smoke.mjs")], {
				cwd: join(consumer, "project"),
				env,
				stdio: "inherit",
				timeout: 45_000,
			});
			const layout = join(temporary, manager, "terminal");
			mkdirSync(layout);
			// The terminal harness accepts explicit consumer paths, avoiding workspace resolution.
			execFileSync("python3", [join(root, "scripts/verify-candidate-artifacts.py"), layout, consumer], {
				env,
				cwd: consumer,
				stdio: "inherit",
				timeout: 90_000,
			});
			cpSync(layout, join(outputDirectory, manager), { recursive: true });
			evidence.processes.push({ manager, server: "passed", terminal: "passed" });
		}
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
