import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
	CONFIG_DIR_NAME,
	detectInstallMethod,
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	getAgentDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getShareViewerUrl,
	getUpdateInstruction,
} from "../src/config.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalDiffexPackageDir = process.env.DIFFEX_PACKAGE_DIR;
const originalDiffexShareViewerUrl = process.env.DIFFEX_SHARE_VIEWER_URL;
const originalArgv1 = process.argv[1];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalDiffexPackageDir === undefined) {
		delete process.env.DIFFEX_PACKAGE_DIR;
	} else {
		process.env.DIFFEX_PACKAGE_DIR = originalDiffexPackageDir;
	}
	if (originalDiffexShareViewerUrl === undefined) {
		delete process.env.DIFFEX_SHARE_VIEWER_URL;
	} else {
		process.env.DIFFEX_SHARE_VIEWER_URL = originalDiffexShareViewerUrl;
	}
	if (originalArgv1 === undefined) {
		process.argv.splice(1, 1);
	} else {
		process.argv[1] = originalArgv1;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "diffex-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@diffexai");
	const packageDir = join(scopeDir, "diffex");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.DIFFEX_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "diffex-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.DIFFEX_PACKAGE_DIR = packageDir;
	setExecPath(
		join(
			root,
			".pnpm",
			"@mariozechner+pi-coding-agent@0.0.0",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "diffex-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@mariozechner", "pi-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.DIFFEX_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@mariozechner", "pi-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "diffex-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@diffexai");
	const packageDir = join(scopeDir, "diffex");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.DIFFEX_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("getShareViewerUrl", () => {
	test("uses a direct GitHub Gist URL by default", () => {
		delete process.env.DIFFEX_SHARE_VIEWER_URL;

		expect(getShareViewerUrl("abc123")).toBe("https://gist.github.com/abc123");
	});

	test("preserves custom share viewers", () => {
		process.env.DIFFEX_SHARE_VIEWER_URL = "https://viewer.example/session/";

		expect(getShareViewerUrl("abc123")).toBe("https://viewer.example/session/#abc123");
	});
});

describe("Diffex configuration namespace", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("uses Diffex names and paths by default", () => {
		vi.stubEnv(ENV_AGENT_DIR, "");

		expect(CONFIG_DIR_NAME).toBe(".diffex");
		expect(ENV_AGENT_DIR).toBe("DIFFEX_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("DIFFEX_CODING_AGENT_SESSION_DIR");
		expect(getAgentDir()).toBe(join(homedir(), ".diffex", "agent"));
	});

	it("honors the Diffex agent directory override", () => {
		vi.stubEnv("DIFFEX_CODING_AGENT_DIR", "/tmp/diffex-agent");

		expect(getAgentDir()).toBe("/tmp/diffex-agent");
	});
});

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@diffexai+diffex@0.67.68\\node_modules\\@diffexai\\diffex\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@diffexai/diffex")).toBe(
			"Run: pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @diffexai/diffex",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@diffexai/diffex")).toBeUndefined();
		expect(getUpdateInstruction("@diffexai/diffex")).toBe(
			"Update @diffexai/diffex using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@diffexai/diffex");

		const install = {
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@diffexai/diffex"],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @diffexai/diffex`,
		};
		const cache = {
			command: "npm",
			args: ["--prefix", prefix, "cache", "add", "--ignore-scripts", "--min-release-age=0", "@diffexai/diffex"],
			display: `npm --prefix ${prefix} cache add --ignore-scripts --min-release-age=0 @diffexai/diffex`,
		};
		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			...install,
			display: `${cache.display} && ${install.display}`,
			steps: [cache, install],
		});
	});

	test("self-updates exact npm versions without uninstalling the current package", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@diffexai/diffex", undefined, {
			packageName: "@diffexai/diffex",
			installSpec: "@diffexai/diffex@1.2.3",
		});

		const install = {
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@diffexai/diffex@1.2.3",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @diffexai/diffex@1.2.3`,
		};
		const cache = {
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"cache",
				"add",
				"--ignore-scripts",
				"--min-release-age=0",
				"@diffexai/diffex@1.2.3",
			],
			display: `npm --prefix ${prefix} cache add --ignore-scripts --min-release-age=0 @diffexai/diffex@1.2.3`,
		};
		expect(command).toEqual({
			...install,
			display: `${cache.display} && ${install.display}`,
			steps: [cache, install],
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@new-scope/pi"],
			display: `npm --prefix ${prefix} cache add --ignore-scripts --min-release-age=0 @new-scope/pi && npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent && npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/pi`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "cache", "add", "--ignore-scripts", "--min-release-age=0", "@new-scope/pi"],
					display: `npm --prefix ${prefix} cache add --ignore-scripts --min-release-age=0 @new-scope/pi`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@new-scope/pi"],
					display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/pi`,
				},
			],
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@diffexai/diffex", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@diffexai/diffex"],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @diffexai/diffex`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@diffexai/diffex", []);

		expect(command).toEqual(getSelfUpdateCommand("@diffexai/diffex"));
		expect(command?.steps?.map((step) => step.args)).toEqual([
			["--prefix", prefix, "cache", "add", "--ignore-scripts", "--min-release-age=0", "@diffexai/diffex"],
			["--prefix", prefix, "install", "-g", "--ignore-scripts", "--min-release-age=0", "@diffexai/diffex"],
		]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("pi prefix ");

		const command = getSelfUpdateCommand("@diffexai/diffex");

		expect(command?.display).toBe(
			`npm --prefix "${prefix}" cache add --ignore-scripts --min-release-age=0 @diffexai/diffex && npm --prefix "${prefix}" install -g --ignore-scripts --min-release-age=0 @diffexai/diffex`,
		);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@diffexai\\diffex";
		process.env.DIFFEX_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@diffexai/diffex")).toBe(
			"Run: npm cache add --ignore-scripts --min-release-age=0 @diffexai/diffex && npm install -g --ignore-scripts --min-release-age=0 @diffexai/diffex",
		);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@diffexai/diffex");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@diffexai/diffex"],
			display: "bun install -g --ignore-scripts --minimum-release-age=0 @diffexai/diffex",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/pi"],
			display:
				"pnpm remove -g @mariozechner/pi-coding-agent && pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/pi",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@mariozechner/pi-coding-agent"],
					display: "pnpm remove -g @mariozechner/pi-coding-agent",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", "@new-scope/pi"],
					display: "pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/pi",
				},
			],
		});
	});

	test("self-updates pnpm v11 global installs resolved through the store", () => {
		const temp = mkdtempSync(join(tmpdir(), "diffex-pnpm11-"));
		const binDir = join(temp, "bin");
		const root = join(temp, "Library", "pnpm", "global", "v11");
		const packageName = "@diffexai/diffex";
		const globalPackageDir = join(root, "11e9a", "node_modules", "@diffexai", "diffex");
		const storePackageDir = join(
			temp,
			"Library",
			"pnpm",
			"store",
			"v11",
			"links",
			"@diffexai",
			"diffex",
			"0.75.0",
			"hash",
			"node_modules",
			"@diffexai",
			"diffex",
		);
		mkdirSync(globalPackageDir, { recursive: true });
		mkdirSync(storePackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(globalPackageDir, "package.json"), "{}");
		writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
		chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
		tempDir = temp;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		process.env.DIFFEX_PACKAGE_DIR = storePackageDir;
		process.argv[1] = join(globalPackageDir, "dist", "cli.js");
		setExecPath(join(storePackageDir, "dist", "cli.js"));

		const command = getSelfUpdateCommand(packageName);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", packageName],
			display: `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ${packageName}`,
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "--ignore-scripts", "@new-scope/pi"],
			display: "yarn global remove @mariozechner/pi-coding-agent && yarn global add --ignore-scripts @new-scope/pi",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@mariozechner/pi-coding-agent"],
					display: "yarn global remove @mariozechner/pi-coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "--ignore-scripts", "@new-scope/pi"],
					display: "yarn global add --ignore-scripts @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/pi"],
			display:
				"bun uninstall -g @mariozechner/pi-coding-agent && bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/pi",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: "bun uninstall -g @mariozechner/pi-coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/pi"],
					display: "bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/pi",
				},
			],
		});
	});

	test("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("@diffexai/diffex")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("@diffexai/diffex")).toContain("the install path is not writable");
	});
});
