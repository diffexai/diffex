import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
} from "../src/config.ts";
import * as httpDispatcher from "../src/core/http-dispatcher.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { main } from "../src/main.ts";
import { handleHomebrewSelfUpdate, handlePackageCommand } from "../src/package-manager-cli.ts";
import { getBundledRuntime, isHomebrewInstall, withBundledRuntimePath } from "../src/utils/bundled-runtime.ts";
import * as childProcesses from "../src/utils/child-process.ts";
import * as versionCheck from "../src/utils/version-check.ts";

const marker = { schemaVersion: 1, package: "@diffexai/diffex", formula: "diffexai/tap/diffex" };
const brewInstruction = "Run: brew upgrade diffexai/tap/diffex";
let tempDir: string;
let root: string;
let packageDir: string;
let node: string;
let npmCli: string;
let markerPath: string;
const originalExecPath = process.execPath;
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalExitCode = process.exitCode;

function writeFixture(path: string, content = ""): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), "diffex-runtime-")));
	root = join(tempDir, "libexec", "diffex");
	packageDir = join(root, "app", "node_modules", "@diffexai", "diffex");
	node = join(root, "runtime", "bin", "node");
	npmCli = join(root, "runtime", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	markerPath = join(tempDir, "libexec", ".diffex-homebrew.json");
	writeFixture(node);
	writeFixture(npmCli);
	writeFixture(join(root, "bin", "diffex"));
	writeFixture(join(packageDir, "dist", "cli.js"));
	writeFixture(join(packageDir, "package.json"), JSON.stringify({ name: "@diffexai/diffex" }));
	chmodSync(node, 0o755);
	chmodSync(join(root, "bin", "diffex"), 0o755);
	vi.stubEnv("DIFFEX_PACKAGE_DIR", packageDir);
	vi.stubEnv("DIFFEX_CODING_AGENT_DIR", join(tempDir, "agent"));
	vi.stubEnv("DIFFEX_OFFLINE", "");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (execPathDescriptor) Object.defineProperty(process, "execPath", execPathDescriptor);
	process.exitCode = originalExitCode;
	rmSync(tempDir, { recursive: true, force: true });
});

describe("bundled runtime layout", () => {
	it("discovers the private runtime without requiring Homebrew ownership", () => {
		expect(getBundledRuntime(packageDir)).toEqual({ root, binDir: dirname(node), node, npmCli });
		expect(isHomebrewInstall(packageDir)).toBe(false);
	});

	it("resolves installation aliases physically", () => {
		const alias = join(tempDir, "opt");
		symlinkSync(root, alias, "junction");
		writeFixture(markerPath, JSON.stringify(marker));
		expect(isHomebrewInstall(join(alias, "app", "node_modules", "@diffexai", "diffex"))).toBe(true);
	});

	it.each([
		"bin/diffex",
		"runtime/bin/node",
		"runtime/lib/node_modules/npm/bin/npm-cli.js",
		"app/node_modules/@diffexai/diffex/dist/cli.js",
	])("rejects an incomplete payload missing %s", (path) => {
		writeFixture(markerPath, JSON.stringify(marker));
		rmSync(join(root, path));
		expect(getBundledRuntime(packageDir)).toBeUndefined();
		expect(isHomebrewInstall(packageDir)).toBe(false);
	});

	it("rejects payload components redirected outside the payload", () => {
		writeFixture(markerPath, JSON.stringify(marker));
		const external = join(tempDir, "external-npm.js");
		writeFixture(external);
		rmSync(npmCli);
		symlinkSync(external, npmCli);
		expect(getBundledRuntime(packageDir)).toBeUndefined();
		expect(isHomebrewInstall(packageDir)).toBe(false);
	});

	it.each([
		"{",
		"null",
		"[]",
		JSON.stringify({ ...marker, schemaVersion: 2 }),
		JSON.stringify({ ...marker, package: "other" }),
		JSON.stringify({ ...marker, formula: "diffex" }),
	])("rejects invalid ownership marker %s", (content) => {
		writeFixture(markerPath, content);
		expect(isHomebrewInstall(packageDir)).toBe(false);
	});

	it("does not accept a marker inside the signed payload or a symlinked marker", () => {
		const internalMarker = join(root, ".diffex-homebrew.json");
		writeFixture(internalMarker, JSON.stringify(marker));
		expect(isHomebrewInstall(packageDir)).toBe(false);
		symlinkSync(internalMarker, markerPath);
		expect(isHomebrewInstall(packageDir)).toBe(false);
	});

	it("supports relocated package overrides outside a Homebrew layout", () => {
		const relocated = join(tempDir, "custom installation");
		renameSync(root, relocated);
		expect(getBundledRuntime(join(relocated, "app", "node_modules", "@diffexai", "diffex"))?.root).toBe(relocated);
		expect(isHomebrewInstall(join(relocated, "app", "node_modules", "@diffexai", "diffex"))).toBe(false);
	});

	it("rejects a symlinked package manifest even when it has the expected identity", () => {
		const manifest = join(packageDir, "package.json");
		const external = join(tempDir, "manifest.json");
		writeFixture(external, JSON.stringify({ name: "@diffexai/diffex" }));
		rmSync(manifest);
		symlinkSync(external, manifest);
		expect(getBundledRuntime(packageDir)).toBeUndefined();
	});

	it("rejects a payload runtime directory replaced by a sibling-prefix alias", () => {
		const sibling = join(tempDir, "libexec", "diffex-other");
		writeFixture(join(sibling, "bin", "node"));
		rmSync(join(root, "runtime"), { recursive: true });
		symlinkSync(sibling, join(root, "runtime"), "junction");
		expect(getBundledRuntime(packageDir)).toBeUndefined();
	});

	it("requires the expected package identity", () => {
		writeFixture(join(packageDir, "package.json"), JSON.stringify({ name: "other" }));
		expect(getBundledRuntime(packageDir)).toBeUndefined();
	});

	it("prepends bundled runtime/bin without mutating the parent environment", () => {
		const env = { PATH: "/user/bin", CUSTOM: "value" };
		expect(withBundledRuntimePath(env, packageDir)).toEqual({
			...env,
			PATH: `${dirname(node)}${delimiter}/user/bin`,
		});
		expect(env.PATH).toBe("/user/bin");
		expect(withBundledRuntimePath({ Path: "/user/bin" }, packageDir)).toEqual({
			Path: `${dirname(node)}${delimiter}/user/bin`,
		});
	});
});

describe("Homebrew ownership", () => {
	beforeEach(() => writeFixture(markerPath, JSON.stringify(marker)));

	it("takes priority over npm/pnpm heuristics and configured npm wrappers without spawning", () => {
		Object.defineProperty(process, "execPath", { value: "/pnpm/node_modules/node", configurable: true });
		const sync = vi.spyOn(childProcesses, "spawnProcessSync").mockImplementation(() => {
			throw new Error("must not discover global npm");
		});
		expect(detectInstallMethod()).toBe("homebrew");
		expect(getSelfUpdateCommand("@diffexai/diffex", ["wrapper"])).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@diffexai/diffex", ["wrapper"])).toBe(brewInstruction);
		expect(getUpdateInstruction("@diffexai/diffex")).toBe(brewInstruction);
		expect(sync).not.toHaveBeenCalled();
	});

	it.each([
		["update"],
		["update", "--self"],
		["update", "self"],
		["update", "diffex"],
		["update", "--force"],
		["update", "--self", "--force"],
	])("prints the offline instruction before discovery for %j", async (...args) => {
		vi.stubEnv("DIFFEX_OFFLINE", "1");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const settings = vi.spyOn(SettingsManager, "create").mockImplementation(() => {
			throw new Error("must not read settings");
		});
		const latest = vi.spyOn(versionCheck, "getLatestDiffexRelease").mockRejectedValue(new Error("offline"));
		const sync = vi.spyOn(childProcesses, "spawnProcessSync");
		const asyncSpawn = vi.spyOn(childProcesses, "spawnProcess");
		expect(await handlePackageCommand(args)).toBe(true);
		expect(log).toHaveBeenCalledExactlyOnceWith(brewInstruction);
		expect(settings).not.toHaveBeenCalled();
		expect(latest).not.toHaveBeenCalled();
		expect(sync).not.toHaveBeenCalled();
		expect(asyncSpawn).not.toHaveBeenCalled();
		expect(existsSync(join(tempDir, "agent"))).toBe(false);
	});

	it("handles pure self-update before main settings and HTTP bootstrap", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const settings = vi.spyOn(SettingsManager, "create").mockImplementation(() => {
			throw new Error("must not bootstrap settings");
		});
		const http = vi.spyOn(httpDispatcher, "configureHttpDispatcher");
		const proxy = vi.spyOn(httpDispatcher, "applyHttpProxySettings");
		const latest = vi.spyOn(versionCheck, "getLatestDiffexRelease");
		const sync = vi.spyOn(childProcesses, "spawnProcessSync");
		const asyncSpawn = vi.spyOn(childProcesses, "spawnProcess");
		await main(["update", "--self", "--force"]);
		expect(log).toHaveBeenCalledExactlyOnceWith(brewInstruction);
		expect(settings).not.toHaveBeenCalled();
		expect(http).not.toHaveBeenCalled();
		expect(proxy).not.toHaveBeenCalled();
		expect(latest).not.toHaveBeenCalled();
		expect(sync).not.toHaveBeenCalled();
		expect(asyncSpawn).not.toHaveBeenCalled();
		expect(existsSync(join(tempDir, "agent"))).toBe(false);
	});

	it.each([
		["update", "--all"],
		["update", "--extensions"],
		["update", "--models"],
		["update", "--help"],
		["update", "--unknown"],
		["update", "--self", "extra"],
		["update", "--self", "--models"],
		["update", "--extension"],
		["--help"],
		["--list-models"],
	])("does not intercept non-self/help/invalid invocation %j", (...args) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(handleHomebrewSelfUpdate(args)).toBe(false);
		expect(log).not.toHaveBeenCalled();
	});

	it
		.skipIf(process.platform === "win32")
		.each([
			["update"],
			["update", "--self"],
			["update", "self"],
			["update", "diffex"],
			["update", "--force"],
			["update", "--self", "--force"],
		])("runs the actual offline CLI without writing user/workspace/payload state for %j", (...args) => {
		const home = join(tempDir, "home");
		const workspace = join(tempDir, "workspace");
		mkdirSync(home);
		mkdirSync(workspace);
		const snapshot = () =>
			readdirSync(tempDir, { recursive: true, withFileTypes: true })
				.map((entry) => {
					const fullPath = join(entry.parentPath, entry.name);
					const path = relative(tempDir, fullPath);
					if (!entry.isFile()) {
						const stats = lstatSync(fullPath);
						return { path, mode: stats.mode, mtimeMs: stats.mtimeMs, content: undefined };
					}
					const fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
					try {
						const stats = fstatSync(fd);
						if (!stats.isFile()) throw new Error("Fixture snapshot requires a regular file");
						return { path, mode: stats.mode, mtimeMs: stats.mtimeMs, content: readFileSync(fd, "base64") };
					} finally {
						closeSync(fd);
					}
				})
				.sort((a, b) => a.path.localeCompare(b.path));
		const before = snapshot();
		const result = spawnSync(
			originalExecPath,
			[`--import=${import.meta.resolve("tsx")}`, resolve(import.meta.dirname, "../src/cli.ts"), ...args],
			{
				cwd: workspace,
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					XDG_CONFIG_HOME: join(home, "config"),
					XDG_CACHE_HOME: join(home, "cache"),
					XDG_DATA_HOME: join(home, "data"),
					PATH: "/nonexistent-system-bin",
					DIFFEX_OFFLINE: "1",
					TSX_DISABLE_CACHE: "1",
					TSX_TSCONFIG_PATH: resolve(import.meta.dirname, "../../../tsconfig.json"),
				},
				encoding: "utf-8",
				timeout: 15_000,
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(brewInstruction);
		expect(result.stderr).toBe("");
		expect(snapshot()).toEqual(before);
		expect(existsSync(join(tempDir, "agent"))).toBe(false);
	});

	it("preserves --all extension updates and skips self-update release/npm discovery", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const settings = SettingsManager.inMemory({}, { projectTrusted: false });
		vi.spyOn(SettingsManager, "create").mockReturnValue(settings);
		const update = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue();
		const latest = vi.spyOn(versionCheck, "getLatestDiffexRelease").mockRejectedValue(new Error("offline"));
		const sync = vi.spyOn(childProcesses, "spawnProcessSync");
		expect(await handlePackageCommand(["update", "--all"])).toBe(true);
		expect(update).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(settings.isProjectTrusted()).toBe(false);
		expect(log).toHaveBeenCalledWith(brewInstruction);
		expect(latest).not.toHaveBeenCalled();
		expect(sync).not.toHaveBeenCalled();
	});

	it("leaves extension-only updates available without a brew instruction", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(SettingsManager, "create").mockReturnValue(SettingsManager.inMemory());
		const update = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue();
		expect(await handlePackageCommand(["update", "--extensions"])).toBe(true);
		expect(update).toHaveBeenCalled();
		expect(log).not.toHaveBeenCalledWith(brewInstruction);
	});
});

describe("bundled private npm extension commands", () => {
	function mockSpawn() {
		return vi.spyOn(childProcesses, "spawnProcess").mockImplementation(() => {
			const child = new EventEmitter();
			Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
			queueMicrotask(() => child.emit("exit", 0));
			return child as ChildProcess;
		});
	}

	it("uses private npm for installs/removals, with runtime PATH and existing lifecycle flags", async () => {
		const spawn = mockSpawn();
		const manager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		await manager.install("npm:example-extension@1.0.0");
		await manager.remove("npm:example-extension");
		expect(spawn).toHaveBeenNthCalledWith(
			1,
			node,
			[
				npmCli,
				"install",
				"example-extension@1.0.0",
				"--prefix",
				join(tempDir, "agent", "npm"),
				"--legacy-peer-deps",
			],
			expect.objectContaining({
				env: expect.objectContaining({
					PATH: expect.stringMatching(new RegExp(`^${dirname(node).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
				}),
			}),
		);
		expect(spawn.mock.calls[0][1]).not.toContain("--ignore-scripts");
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			node,
			[npmCli, "uninstall", "example-extension", "--prefix", join(tempDir, "agent", "npm"), "--legacy-peer-deps"],
			expect.anything(),
		);
	});

	it("uses private npm and runtime PATH for git dependency installs", async () => {
		const spawn = mockSpawn();
		const target = join(tempDir, "agent", "git", "github.com", "example", "extension");
		spawn.mockImplementation((_command, args) => {
			if (args[0] === "clone") writeFixture(join(target, "package.json"), "{}");
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("exit", 0));
			return child as ChildProcess;
		});
		const manager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		await manager.install("git:github.com/example/extension");
		expect(spawn.mock.calls[0][0]).toBe("git");
		expect(spawn.mock.calls[0][2].env?.PATH?.split(delimiter)[0]).toBe(dirname(node));
		expect(spawn).toHaveBeenLastCalledWith(
			node,
			[npmCli, "install", "--omit=dev"],
			expect.objectContaining({ cwd: target }),
		);
	});

	it("honors explicit npmCommand instead of the private default and retains bundled PATH", async () => {
		const spawn = mockSpawn();
		const settings = SettingsManager.inMemory({ npmCommand: ["wrapper", "--", "pnpm"] });
		const manager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: settings,
		});
		await manager.install("npm:example-extension");
		expect(spawn.mock.calls[0][0]).toBe("wrapper");
		expect(spawn.mock.calls[0][1]).toEqual([
			"--",
			"pnpm",
			"install",
			"example-extension",
			"--prefix",
			join(tempDir, "agent", "npm"),
			"--config.auto-install-peers=false",
			"--config.strict-peer-dependencies=false",
			"--config.strict-dep-builds=false",
		]);
		expect(spawn.mock.calls[0][2].env?.PATH?.split(delimiter)[0]).toBe(dirname(node));
	});

	it("identifies explicitly Node-invoked npm as npm for remove flags", async () => {
		const spawn = mockSpawn();
		const settings = SettingsManager.inMemory({ npmCommand: ["node", npmCli] });
		const manager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: settings,
		});
		mkdirSync(join(tempDir, "agent", "npm"), { recursive: true });
		await manager.remove("npm:example-extension");
		expect(spawn.mock.calls[0][0]).toBe("node");
		expect((manager as unknown as { getPackageManagerName(): string }).getPackageManagerName()).toBe("npm");
		expect(spawn.mock.calls[0][1]).toContain("--legacy-peer-deps");
	});

	it("uses system npm for ordinary installs without a bundled payload", async () => {
		const spawn = mockSpawn();
		vi.stubEnv("DIFFEX_PACKAGE_DIR", tempDir);
		const manager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory(),
		});
		await manager.install("npm:example-extension");
		expect(spawn.mock.calls[0][0]).toBe("npm");
		expect(spawn.mock.calls[0][1][0]).toBe("install");
	});

	it("refuses project npm installation before spawning in an untrusted workspace", async () => {
		const spawn = mockSpawn();
		const manager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
		});
		await expect(manager.install("npm:example-extension", { local: true })).rejects.toThrow("Project is not trusted");
		expect(spawn).not.toHaveBeenCalled();
		expect(existsSync(join(tempDir, ".diffex", "npm"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"executes private npm with no system npm and exposes node to lifecycle subprocesses",
		async () => {
			// A local fake npm CLI exercises actual process execution without registry access.
			writeFixture(node, `#!/bin/sh\nexec ${JSON.stringify(originalExecPath)} "$@"\n`);
			chmodSync(node, 0o755);
			const recordPath = join(tempDir, "npm-execution.json");
			writeFixture(
				npmCli,
				`const fs = require("node:fs"); const cp = require("node:child_process"); fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({args: process.argv.slice(2), path: process.env.PATH, child: cp.spawnSync("node", ["-p", "'lifecycle-ok'"], {encoding:"utf8"}).stdout.trim()}) + "\\n"); if (process.argv[2] === "root") console.log(${JSON.stringify(join(tempDir, "missing-global"))}); if (process.argv[2] === "view") console.log('"1.1.0"');`,
			);
			vi.stubEnv("PATH", "/nonexistent-system-bin");
			const manager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir: join(tempDir, "agent"),
				settingsManager: SettingsManager.inMemory({ packages: ["npm:local-fixture"] }),
			});
			expect(manager.getInstalledPath("npm:missing", "user")).toBeUndefined();
			await manager.install("npm:local-fixture");
			writeFixture(
				join(tempDir, "agent", "npm", "node_modules", "local-fixture", "package.json"),
				JSON.stringify({ version: "1.0.0" }),
			);
			await manager.update();
			const records = readFileSync(recordPath, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { args: string[]; path: string; child: string });
			expect(records.map((record) => record.args[0])).toEqual(["root", "install", "view", "install"]);
			for (const record of records) {
				expect(record.args).not.toContain("--ignore-scripts");
				expect(record.path.split(delimiter)[0]).toBe(dirname(node));
				expect(record.child).toBe("lifecycle-ok");
			}
			expect((spawnSync("npm", ["--version"]).error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
		},
	);
});
