import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const packageDir = resolve(import.meta.dirname, "../..");
const repositoryDir = resolve(packageDir, "../..");
const packageJson = readFileSync(join(packageDir, "package.json"), "utf8");
export const installed = JSON.parse(packageJson) as { name: string; version: string };
export const endpoint = "https://api.diffex.ai/api/latest-version";

export interface RecordedEvent {
	type: string;
	status?: number;
	body?: unknown;
	cacheControl?: string;
	contentType?: string;
	host?: string;
	port?: number;
	url?: string;
	method?: string;
	userAgent?: string;
	redirect?: string;
	command?: string;
	args?: string[];
}

export async function reproduce(options: {
	/** Reuse only the compiler cache; the caller owns this directory's lifetime. */
	sharedTempDir?: string;
	/** Hold discovery until a rendered command confirms the interactive loop is accepting input. */
	delayResponse?: boolean;
	/** Optional package asset for reproducing upgrades independently of repository release history. */
	changelog?: string;
	settings?: Record<string, unknown>;
	legacyTelemetryEnv?: string;
	providerAttributionEnv?: string;
	staging?: boolean;
	installedVersion?: string;
	interactive?: boolean;
	force?: boolean;
	offline?: boolean;
	skip?: boolean;
	failure?: boolean;
	packageName?: string;
	version?: string;
	response?: string;
	status?: number;
	redirect?: string;
}) {
	assert.ok(!options.delayResponse || (options.interactive && !options.offline && !options.skip && !options.staging));
	const root = mkdtempSync(join(options.sharedTempDir ?? tmpdir(), "diffex-version-repro-"));
	const childTempDir = options.sharedTempDir ?? root;
	const agentDir = join(root, "agent");
	const recordPath = join(root, "events.jsonl");
	const releaseResponsePath = join(root, "release-response");
	const homeDir = join(root, "home");
	const cwd = join(root, "project");
	for (const dir of [agentDir, homeDir, cwd]) mkdirSync(dir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", packages: [], ...options.settings }));
	writeFileSync(recordPath, "");
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: homeDir,
		USERPROFILE: homeDir,
		TMPDIR: childTempDir,
		TMP: childTempDir,
		TEMP: childTempDir,
		XDG_CONFIG_HOME: join(homeDir, ".config"),
		XDG_CACHE_HOME: join(homeDir, ".cache"),
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
		TSX_TSCONFIG_PATH: join(repositoryDir, "tsconfig.json"),
		DIFFEX_CODING_AGENT_DIR: agentDir,
		DIFFEX_NO_LOCAL_LLM: "1",
		DIFFEX_TELEMETRY: options.legacyTelemetryEnv,
		DIFFEX_PROVIDER_ATTRIBUTION: options.providerAttributionEnv,
		DIFFEX_REPRO_RECORD: recordPath,
		DIFFEX_REPRO_RELEASE_RESPONSE: options.delayResponse ? releaseResponsePath : undefined,
		DIFFEX_REPRO_STAGING: options.staging ? "1" : "",
		DIFFEX_REPRO_VERSION: options.version ?? (options.force ? installed.version : "9999.0.0"),
		DIFFEX_REPRO_PACKAGE: options.packageName ?? "@foreign-fixture/untrusted-cli",
		DIFFEX_REPRO_RESPONSE: options.response,
		DIFFEX_REPRO_STATUS: String(options.status ?? 200),
		DIFFEX_REPRO_REDIRECT: options.redirect,
		DIFFEX_REPRO_FAILURE: options.failure ? "1" : "",
		DIFFEX_OFFLINE: options.offline ? "1" : "",
		DIFFEX_SKIP_VERSION_CHECK: options.skip ? "1" : "",
	};
	if (!options.interactive || options.changelog !== undefined) {
		const fakePackageDir = join(root, "lib", "node_modules", ...installed.name.split("/"));
		mkdirSync(fakePackageDir, { recursive: true });
		writeFileSync(
			join(fakePackageDir, "package.json"),
			JSON.stringify({ ...installed, version: options.installedVersion ?? installed.version }),
		);
		env.DIFFEX_PACKAGE_DIR = fakePackageDir;
		if (options.changelog !== undefined) {
			writeFileSync(join(fakePackageDir, "CHANGELOG.md"), options.changelog);
			// Keep real themes and interactive assets when substituting only the release history.
			symlinkSync(join(packageDir, "src"), join(fakePackageDir, "src"), "dir");
			symlinkSync(join(packageDir, "docs"), join(fakePackageDir, "docs"), "dir");
		}
	}
	const nodeArgs = [
		`--import=${import.meta.resolve("tsx")}`,
		`--import=${join(import.meta.dirname, "version-update-guard.mjs")}`,
		join(packageDir, "src/cli.ts"),
		...(options.interactive ? ["--no-session", "--no-extensions", "--no-skills"] : ["update", "--self"]),
		...(options.force ? ["--force"] : []),
	];
	const started = performance.now();
	const child = options.interactive
		? spawn("python3", [join(import.meta.dirname, "version-update-terminal.py"), process.execPath, ...nodeArgs], {
				cwd,
				env,
				stdio: "pipe",
			})
		: spawn(process.execPath, nodeArgs, { cwd, env, stdio: "pipe" });
	let output = "";
	let quitSent = false;
	let deadlineReached = false;
	let phase: "startup" | "ready" | "discovery" | "settled" | "exit" = "startup";
	const interactions: string[] = [];
	let inputBeforeResponse = false;
	const completion = new Promise<number | null>((resolveExit, reject) => {
		child.once("error", reject);
		child.once("close", resolveExit);
	});
	const interact = () => {
		if (!options.interactive || quitSent) return;
		const rendered = stripVTControlCharacters(output);
		if (phase === "startup" && rendered.includes("Diffex v")) {
			phase = "ready";
			child.stdin.write("/name ci-ready\r");
		}
		if (phase === "ready" && rendered.includes("Session name set: ci-ready")) {
			interactions.push("ci-ready");
			phase = "discovery";
		}
		if (phase === "discovery") {
			const events = readFileSync(recordPath, "utf8");
			if (options.delayResponse && !existsSync(releaseResponsePath)) {
				// A recorded request plus rendered confirmation proves input works while fetch is pending.
				if (!events.includes('"type":"request"')) return;
				inputBeforeResponse = !events.includes('"type":"discovery-settled"');
				writeFileSync(releaseResponsePath, "release");
			}
			if (!options.offline && !options.skip && !events.includes('"type":"discovery-settled"')) return;
			phase = "settled";
			child.stdin.write("/name ci-settled\r");
		}
		if (phase === "settled" && rendered.includes("Session name set: ci-settled")) {
			interactions.push("ci-settled");
			phase = "exit";
			quitSent = true;
			child.stdin.write("/exit\r");
		}
	};
	const interactionPoll = setInterval(interact, 25);
	const capture = (chunk: Buffer) => {
		output += chunk.toString();
		interact();
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const timeout = setTimeout(() => {
		deadlineReached = true;
		child.kill("SIGTERM");
	}, 20_000);
	try {
		const code = await completion;
		const events = readFileSync(recordPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as RecordedEvent);
		assert.equal(
			deadlineReached,
			false,
			`Timed out in ${phase}\n${JSON.stringify(events)}\n${stripVTControlCharacters(output)}`,
		);
		assert.deepEqual(
			events.filter((event) => event.type === "blocked-network" || event.type === "blocked-process"),
			[],
			output,
		);
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return {
			code,
			events,
			output: stripVTControlCharacters(output),
			quitSent,
			prefix: root,
			settings,
			interactions,
			inputBeforeResponse,
			durationMs: performance.now() - started,
		};
	} finally {
		clearTimeout(timeout);
		clearInterval(interactionPoll);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await completion.catch(() => {});
		}
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
	}
}
