import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

const packageDir = resolve(import.meta.dirname, "..");
const repositoryDir = resolve(packageDir, "../..");
const packageJson = readFileSync(join(packageDir, "package.json"), "utf8");
const installed = JSON.parse(packageJson) as { name: string; version: string };
const endpoint = "https://api.diffex.ai/api/latest-version";

interface RecordedEvent {
	type: string;
	url?: string;
	method?: string;
	userAgent?: string;
	redirect?: string;
	command?: string;
	args?: string[];
}

async function reproduce(options: {
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
	const root = mkdtempSync(join(tmpdir(), "diffex-version-repro-"));
	const agentDir = join(root, "agent");
	const recordPath = join(root, "events.jsonl");
	const homeDir = join(root, "home");
	const cwd = join(root, "project");
	for (const dir of [agentDir, homeDir, cwd]) mkdirSync(dir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", packages: [] }));
	writeFileSync(recordPath, "");
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: homeDir,
		USERPROFILE: homeDir,
		TMPDIR: root,
		XDG_CONFIG_HOME: join(homeDir, ".config"),
		XDG_CACHE_HOME: join(homeDir, ".cache"),
		TERM: "xterm-256color",
		LANG: "en_US.UTF-8",
		TSX_TSCONFIG_PATH: join(repositoryDir, "tsconfig.json"),
		DIFFEX_CODING_AGENT_DIR: agentDir,
		DIFFEX_NO_LOCAL_LLM: "1",
		DIFFEX_REPRO_RECORD: recordPath,
		DIFFEX_REPRO_VERSION: options.version ?? (options.force ? installed.version : "9999.0.0"),
		DIFFEX_REPRO_PACKAGE: options.packageName ?? "@foreign-fixture/untrusted-cli",
		DIFFEX_REPRO_RESPONSE: options.response,
		DIFFEX_REPRO_STATUS: String(options.status ?? 200),
		DIFFEX_REPRO_REDIRECT: options.redirect,
		DIFFEX_REPRO_FAILURE: options.failure ? "1" : "",
		DIFFEX_OFFLINE: options.offline ? "1" : "",
		DIFFEX_SKIP_VERSION_CHECK: options.skip ? "1" : "",
	};
	if (!options.interactive) {
		const fakePackageDir = join(root, "lib", "node_modules", ...installed.name.split("/"));
		mkdirSync(fakePackageDir, { recursive: true });
		writeFileSync(join(fakePackageDir, "package.json"), packageJson);
		env.DIFFEX_PACKAGE_DIR = fakePackageDir;
	}
	const nodeArgs = [
		`--import=${import.meta.resolve("tsx")}`,
		`--import=${join(import.meta.dirname, "fixtures/version-update-guard.mjs")}`,
		join(packageDir, "src/cli.ts"),
		...(options.interactive ? ["--no-session", "--no-extensions", "--no-skills"] : ["update", "--self"]),
		...(options.force ? ["--force"] : []),
	];
	const child = options.interactive
		? spawn(
				"python3",
				[join(import.meta.dirname, "fixtures/version-update-terminal.py"), process.execPath, ...nodeArgs],
				{
					cwd,
					env,
					stdio: "pipe",
				},
			)
		: spawn(process.execPath, nodeArgs, { cwd, env, stdio: "pipe" });
	let output = "";
	let quitSent = false;
	let deadlineReached = false;
	const completion = new Promise<number | null>((resolveExit, reject) => {
		child.once("error", reject);
		child.once("close", resolveExit);
	});
	const capture = (chunk: Buffer) => {
		output += chunk.toString();
		// /exit travels through the real editor after the welcome screen is rendered.
		if (options.interactive && !quitSent && stripVTControlCharacters(output).includes("Diffex v")) {
			quitSent = true;
			child.stdin.write("/exit\r");
		}
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
		expect(deadlineReached, stripVTControlCharacters(output)).toBe(false);
		expect(
			events.filter((event) => event.type === "blocked-network" || event.type === "blocked-process"),
			output,
		).toEqual([]);
		return { code, events, output: stripVTControlCharacters(output), quitSent, prefix: root };
	} finally {
		clearTimeout(timeout);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await completion.catch(() => {});
		}
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
}

function versionRequests(events: RecordedEvent[]) {
	return events.filter((event) => event.type === "request" && event.url === endpoint);
}

// The source CLI must reject untrusted targets before dispatching package commands.
describe.skipIf(process.platform === "win32")("version discovery through the source CLI", () => {
	it("contacts only the canonical authority with redirects disabled", async () => {
		const result = await reproduce({ packageName: "@diffexai/diffex" });
		expect(result.code, result.output).toBe(0);
		expect(result.events.filter((event) => event.type === "request")).toEqual([
			{
				type: "request",
				url: endpoint,
				method: "GET",
				userAgent: expect.stringMatching(/^diffex\//),
				redirect: "manual",
			},
		]);
	});

	it.each([
		{
			name: "no published release",
			status: 404,
			response: '{"error":"no_published_release"}',
			requests: 1,
			message: "No published Diffex release is available yet.",
		},
		{
			name: "service unavailable",
			status: 503,
			response: '{"error":"release_unavailable"}',
			requests: 3,
			message: "Diffex update service is unavailable.",
		},
		{
			name: "unrelated not found",
			status: 404,
			response: '{"error":"not_found"}',
			requests: 1,
			message: "Diffex update service is unavailable.",
		},
		{
			name: "invalid JSON",
			status: 200,
			response: "{",
			requests: 1,
			message: "Diffex update service is unavailable.",
		},
		{
			name: "missing identity",
			status: 200,
			response: '{"version":"9999.0.0"}',
			requests: 1,
			message: "Refusing self-update",
		},
		{
			name: "unexpected note",
			status: 200,
			response: '{"version":"9999.0.0","packageName":"@diffexai/diffex","note":"unverified note"}',
			requests: 1,
			message: "Refusing self-update",
		},
		{
			name: "foreign redirect",
			status: 302,
			response: "{}",
			redirect: "https://unreviewed.invalid/latest",
			requests: 1,
			message: "Diffex update service is unavailable.",
		},
	])("reports $name without package mutation, including force", async ({ requests, message, ...options }) => {
		const result = await reproduce({ ...options, force: true });
		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain(message);
		expect(versionRequests(result.events)).toHaveLength(requests);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
	});

	it.each(["0.0.0", installed.version])("does not install an older or equal release %s", async (version) => {
		const result = await reproduce({ packageName: "@diffexai/diffex", version });
		expect(result.code, result.output).toBe(0);
		expect(versionRequests(result.events)).toHaveLength(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).toContain("already up to date");
	});

	it.each([false, true])("rejects foreign packages before any command with force=%s", async (force) => {
		const result = await reproduce({ force });
		expect(result.code, result.output).toBe(1);
		expect(versionRequests(result.events)).toHaveLength(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).toContain("Refusing self-update: expected a stable @diffexai/diffex release.");
	});

	it.each([false, true])("pins canonical installation without uninstall with force=%s", async (force) => {
		const result = await reproduce({ force, packageName: "@diffexai/diffex" });
		expect(result.code, result.output).toBe(0);
		expect(versionRequests(result.events)).toHaveLength(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([
			{
				type: "spawn",
				command: "npm",
				args: [
					"--prefix",
					result.prefix,
					"install",
					"-g",
					"--ignore-scripts",
					"--min-release-age=0",
					`@diffexai/diffex@${force ? installed.version : "9999.0.0"}`,
				],
			},
		]);
	});

	it.each([
		"npm:foreign@1.2.3",
		"https://example.invalid/install.tgz",
		"1.2.3-beta.1",
		"1.2.3+build",
		"v1.2.3",
		"01.2.3",
		"9007199254740992.0.0",
	])("rejects unsafe version %s even with force", async (version) => {
		const result = await reproduce({ force: true, packageName: "@diffexai/diffex", version });
		expect(result.code, result.output).toBe(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).toContain("Refusing self-update");
	});

	it.each([false, true])("offline suppresses manual discovery and commands with force=%s", async (force) => {
		const result = await reproduce({ offline: true, force });
		expect(result.code, result.output).toBe(1);
		expect(result.events).toEqual([]);
		expect(result.output).toContain("Could not determine latest diffex version.");
	});

	it("automatic opt-out permits manual discovery but cannot bypass package validation", async () => {
		const result = await reproduce({ skip: true });
		expect(result.code, result.output).toBe(1);
		expect(versionRequests(result.events)).toHaveLength(1);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
	});

	it("manual network failure retries twice without attempting package mutation", async () => {
		const result = await reproduce({ failure: true });
		expect(result.code, result.output).toBe(1);
		expect(versionRequests(result.events)).toHaveLength(3);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).toContain("Diffex update service is unavailable: controlled network failure");
	});

	it.each([
		{ name: "foreign response", expectedRequests: 1 },
		{ name: "canonical response", packageName: "@diffexai/diffex", expectedRequests: 1 },
		{ name: "offline", offline: true, expectedRequests: 0 },
		{ name: "automatic opt-out", skip: true, expectedRequests: 0 },
		{ name: "network failure", failure: true, expectedRequests: 1 },
		{ name: "no release", status: 404, response: '{"error":"no_published_release"}', expectedRequests: 1 },
		{ name: "service failure", status: 503, response: '{"error":"release_unavailable"}', expectedRequests: 1 },
	])("interactive startup stays quiet for $name", async ({ expectedRequests, ...options }) => {
		const result = await reproduce({ ...options, interactive: true });
		expect(result.code, result.output).toBe(0);
		expect(result.quitSent).toBe(true);
		expect(versionRequests(result.events)).toHaveLength(expectedRequests);
		expect(result.events.filter((event) => event.type === "spawn")).toEqual([]);
		expect(result.output).not.toContain("New version");
		expect(result.output).not.toContain("Could not determine latest");
		expect(result.output).not.toContain("controlled network failure");
		expect(result.output).not.toContain("update service");
		expect(result.output).not.toContain("No published Diffex release");
		expect(result.output).not.toContain("Refusing self-update");
	});
});
