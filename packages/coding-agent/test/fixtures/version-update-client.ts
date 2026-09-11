import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	if (!options.interactive) {
		const fakePackageDir = join(root, "lib", "node_modules", ...installed.name.split("/"));
		mkdirSync(fakePackageDir, { recursive: true });
		writeFileSync(
			join(fakePackageDir, "package.json"),
			JSON.stringify({ ...installed, version: options.installedVersion ?? installed.version }),
		);
		env.DIFFEX_PACKAGE_DIR = fakePackageDir;
	}
	const nodeArgs = [
		`--import=${import.meta.resolve("tsx")}`,
		`--import=${join(import.meta.dirname, "version-update-guard.mjs")}`,
		join(packageDir, "src/cli.ts"),
		...(options.interactive ? ["--no-session", "--no-extensions", "--no-skills"] : ["update", "--self"]),
		...(options.force ? ["--force"] : []),
	];
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
	const completion = new Promise<number | null>((resolveExit, reject) => {
		child.once("error", reject);
		child.once("close", resolveExit);
	});
	const sendExit = () => {
		const awaitingResponse =
			options.staging &&
			!options.offline &&
			!options.skip &&
			!readFileSync(recordPath, "utf8").includes('"type":"staging-response"');
		if (
			options.interactive &&
			!awaitingResponse &&
			!quitSent &&
			stripVTControlCharacters(output).includes("Diffex v")
		) {
			quitSent = true;
			child.stdin.write("/exit\r");
		}
	};
	const exitPoll = setInterval(sendExit, 50);
	const capture = (chunk: Buffer) => {
		output += chunk.toString();
		sendExit();
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
		assert.equal(deadlineReached, false, stripVTControlCharacters(output));
		assert.deepEqual(
			events.filter((event) => event.type === "blocked-network" || event.type === "blocked-process"),
			[],
			output,
		);
		return { code, events, output: stripVTControlCharacters(output), quitSent, prefix: root };
	} finally {
		clearTimeout(timeout);
		clearInterval(exitPoll);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await completion.catch(() => {});
		}
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
	}
}
