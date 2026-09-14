import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME, VERSION } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResolvedPaths } from "../src/core/package-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { main } from "../src/main.ts";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { allowNetwork } from "./test-network-env.ts";

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalDiffexPackageDir: string | undefined;
	let originalPath: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	async function runPackageCommandDirectly(args: string[]): Promise<void> {
		expect(await handlePackageCommand(args)).toBe(true);
	}

	function extensionPaths(
		packageRoot: string,
		source: string,
		scope: "user" | "project",
		names: string[],
	): ResolvedPaths {
		return {
			extensions: names.map((name) => ({
				path: join(packageRoot, "extensions", name),
				enabled: true,
				metadata: { source, scope, origin: "package", baseDir: packageRoot },
			})),
			skills: [],
			prompts: [],
			themes: [],
		};
	}

	beforeEach(() => {
		allowNetwork();
		tempDir = join(tmpdir(), `diffex-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalDiffexPackageDir = process.env.DIFFEX_PACKAGE_DIR;
		originalPath = process.env.PATH;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			if (code === undefined || code === null || Number(code) === 0) {
				process.exitCode = undefined;
			} else {
				process.exitCode = code;
			}
			return undefined as never;
		}) as typeof process.exit);
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalDiffexPackageDir === undefined) {
			delete process.env.DIFFEX_PACKAGE_DIR;
		} else {
			process.env.DIFFEX_PACKAGE_DIR = originalDiffexPackageDir;
		}
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("asks interactive installs to choose global scope", async () => {
		const selectInstallScope = vi.fn(async () => "global" as const);

		expect(await handlePackageCommand(["install", packageDir], { selectInstallScope })).toBe(true);

		expect(selectInstallScope).toHaveBeenCalledWith({ source: packageDir, cwd: realpathSync(projectDir), agentDir });
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
			packages?: string[];
		};
		expect(settings.packages).toHaveLength(1);
		expect(existsSync(join(projectDir, ".diffex", "settings.json"))).toBe(false);
	});

	it("installs into the selected workspace without falling back globally", async () => {
		const selectInstallScope = vi.fn(async () => "workspace" as const);

		expect(await handlePackageCommand(["install", packageDir, "--approve"], { selectInstallScope })).toBe(true);

		expect(selectInstallScope).toHaveBeenCalledOnce();
		const settings = JSON.parse(readFileSync(join(projectDir, ".diffex", "settings.json"), "utf-8")) as {
			packages?: string[];
		};
		expect(settings.packages).toHaveLength(1);
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});

	it("cancels an interactive install without writing either scope", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const selectInstallScope = vi.fn(async () => undefined);

		expect(await handlePackageCommand(["install", packageDir], { selectInstallScope })).toBe(true);

		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Installation cancelled.");
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		expect(existsSync(join(projectDir, ".diffex", "settings.json"))).toBe(false);
	});

	it("does not ask for scope when the workspace flag is explicit", async () => {
		const selectInstallScope = vi.fn(async () => "global" as const);

		expect(await handlePackageCommand(["install", "-l", "--approve", packageDir], { selectInstallScope })).toBe(true);

		expect(selectInstallScope).not.toHaveBeenCalled();
		expect(existsSync(join(projectDir, ".diffex", "settings.json"))).toBe(true);
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("skips untrusted project package settings", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(projectDir, ".diffex", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses remembered project trust for list", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(projectDir, ".diffex", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("overrides remembered trust for list with --no-approve", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(projectDir, ".diffex", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--no-approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("approves project trust for list with --approve", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(projectDir, ".diffex", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list", "--approve"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses default project trust for list", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".diffex", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses project_trust extensions for package commands", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(projectDir, ".diffex", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["list"], {
					extensionFactories: [
						(pi) => {
							pi.on("project_trust", () => ({ trusted: "yes" }));
						},
					],
				}),
			).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Project packages:");
			expect(stdout).toContain("npm:@project/pkg");
			expect(stdout).not.toContain("No packages installed.");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("does not prompt or ask extensions for project trust during update", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const fakeNpmPath = join(tempDir, "fake-project-npm.cjs");
		const recordPath = join(tempDir, "project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, ".diffex", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		let projectTrustCalled = false;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(
				main(["update", "--extensions"], {
					extensionFactories: [
						(pi) => {
							pi.on("project_trust", () => {
								projectTrustCalled = true;
								return { trusted: "yes" };
							});
						},
					],
				}),
			).resolves.toBeUndefined();

			expect(projectTrustCalled).toBe(false);
			expect(existsSync(recordPath)).toBe(false);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("uses saved project trust during update", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		const fakeNpmPath = join(tempDir, "fake-trusted-project-npm.cjs");
		const recordPath = join(tempDir, "trusted-project-update.json");
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(process.argv.slice(2)));`,
		);
		writeFileSync(
			join(projectDir, ".diffex", "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [originalExecPath, fakeNpmPath] }),
		);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "--extensions"])).resolves.toBeUndefined();

			expect(existsSync(recordPath)).toBe(true);
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("lets trust.json override default project trust", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		writeFileSync(join(projectDir, ".diffex", "settings.json"), JSON.stringify({ packages: ["npm:@project/pkg"] }));
		new ProjectTrustStore(agentDir).set(projectDir, false);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["list"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("No packages installed.");
			expect(stdout).not.toContain("Project packages:");
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("blocks local package changes when project is untrusted", async () => {
		mkdirSync(join(projectDir, ".diffex"), { recursive: true });
		writeFileSync(join(projectDir, ".diffex", "settings.json"), "{}");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "-l", "./local-package"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Project is not trusted. Use --approve to modify local package config.");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("allows local package install to initialize fresh project settings", async () => {
		await main(["install", "-l", packageDir]);

		const settingsPath = join(projectDir, ".diffex", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		expect(realpathSync(join(projectDir, ".diffex", stored))).toBe(realpathSync(packageDir));
		expect(process.exitCode).toBeUndefined();
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain("diffex install <source> [-l]");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("refreshes only model catalogs with update --models", async () => {
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() }));
		const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue({ refresh } as unknown as ModelRuntime);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--models"])).resolves.toBeUndefined();

		expect(create).toHaveBeenCalledWith({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: expect.any(AbortSignal),
		});
		expect(refresh).toHaveBeenCalledWith({
			allowNetwork: true,
			force: true,
			signal: expect.any(AbortSignal),
		});
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Model catalogs refreshed");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("rejects update --models combined with another update target", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(runPackageCommandDirectly(["update", "--models", "--self"])).resolves.toBeUndefined();

		expect(create).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"--models cannot be combined with --self",
		);
		expect(process.exitCode).toBe(1);
	});

	it("cycles project package overrides in config local mode", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ packages: ["npm:pi-tools"] }));
		const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: true });
		const resolvedPaths = extensionPaths(join(tempDir, "pkg"), "npm:pi-tools", "user", ["bar.ts"]);
		const selector = new ConfigSelectorComponent(
			{ global: resolvedPaths, project: resolvedPaths },
			settingsManager,
			projectDir,
			agentDir,
			() => {},
			() => {},
			() => {},
			24,
			"project",
		);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, extensions: ["-extensions/bar.ts"] },
		]);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([
			{ source: "npm:pi-tools", autoload: false, extensions: ["+extensions/bar.ts"] },
		]);

		selector.getResourceList().handleInput(" ");
		expect(settingsManager.getProjectSettings().packages).toEqual([]);
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain('Use "diffex --help" or "diffex install <source> [-l] [--approve|--no-approve]".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain("Usage: diffex install <source> [-l]");
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	describe("self-update validation and installation", () => {
		let globalPrefix: string;
		let recordPath: string;
		let preservedFiles: Map<string, string>;
		let stdout: string[];
		let stderr: string[];

		beforeEach(() => {
			globalPrefix = join(tempDir, "global-prefix");
			const selfPackageDir = join(globalPrefix, "lib", "node_modules", ...PACKAGE_NAME.split("/"));
			const fakeNpmPath = join(tempDir, "fake-npm.cjs");
			recordPath = join(tempDir, "self-update.json");
			mkdirSync(selfPackageDir, { recursive: true });
			mkdirSync(join(projectDir, ".diffex"), { recursive: true });
			writeFileSync(recordPath, "[]");
			writeFileSync(
				fakeNpmPath,
				`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else {
	const records=JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8"));
	records.push(args);
	fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
}
`,
			);
			preservedFiles = new Map([
				[
					join(agentDir, "settings.json"),
					JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }),
				],
				[
					join(projectDir, ".diffex", "settings.json"),
					JSON.stringify({
						npmCommand: [originalExecPath, fakeNpmPath, "--prefix", join(tempDir, "project-prefix")],
					}),
				],
				[join(selfPackageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: VERSION })],
				[join(selfPackageDir, "sentinel"), "existing installation"],
			]);
			for (const [path, contents] of preservedFiles) writeFileSync(path, contents);
			process.env.DIFFEX_PACKAGE_DIR = selfPackageDir;
			Object.defineProperty(process, "execPath", {
				value: join(selfPackageDir, "dist", "cli.js"),
				configurable: true,
			});
			stdout = [];
			stderr = [];
			vi.spyOn(console, "log").mockImplementation((message: unknown) => stdout.push(String(message)));
			vi.spyOn(console, "error").mockImplementation((message: unknown) => stderr.push(String(message)));
		});

		afterEach(() => {
			for (const [path, contents] of preservedFiles) expect(readFileSync(path, "utf8")).toBe(contents);
		});

		function expectNoInstallation() {
			expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual([]);
			expect(stdout.join("\n")).not.toContain("Updated diffex");
		}

		it.each(["0.0.0", VERSION])("keeps release %s without installing after automatic opt-out", async (version) => {
			vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", "1");
			const fetchMock = vi.fn(async () => Response.json({ version, packageName: PACKAGE_NAME }));
			vi.stubGlobal("fetch", fetchMock);

			await runPackageCommandDirectly(["update", "--self"]);

			expect(fetchMock).toHaveBeenCalledOnce();
			expect(stdout.join("\n")).toContain(`diffex is already up to date (v${VERSION})`);
			expect(stderr).toEqual([]);
			expect(process.exitCode).toBeUndefined();
			expectNoInstallation();
		});

		it("retries a transient self-update version check", async () => {
			const fetchMock = vi
				.fn()
				.mockRejectedValueOnce(new Error("fetch failed"))
				.mockRejectedValueOnce(new Error("fetch failed"))
				.mockResolvedValueOnce(Response.json({ version: VERSION, packageName: PACKAGE_NAME }));
			vi.stubGlobal("fetch", fetchMock);

			await runPackageCommandDirectly(["update", "--self"]);

			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(stdout.join("\n")).toContain(`diffex is already up to date (v${VERSION})`);
			expect(stderr).toEqual([]);
			expect(process.exitCode).toBeUndefined();
			expectNoInstallation();
		});

		it.each([
			{ name: "newer release after automatic opt-out", version: getNewerPatchVersion(), force: false },
			{ name: "forced current release", version: VERSION, force: true },
		])("pins the $name in the global prefix without uninstalling", async ({ version, force }) => {
			vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", "1");
			const fetchMock = vi.fn(async () => Response.json({ version, packageName: PACKAGE_NAME }));
			vi.stubGlobal("fetch", fetchMock);

			await runPackageCommandDirectly(["update", "--self", ...(force ? ["--force"] : [])]);

			expect(process.exitCode).toBeUndefined();
			expect(stderr).toEqual([]);
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual([
				[
					"--prefix",
					globalPrefix,
					"install",
					"-g",
					"--ignore-scripts",
					"--min-release-age=0",
					`${PACKAGE_NAME}@${version}`,
				],
			]);
			expect(stdout.join("\n")).toContain(`Updated diffex from ${VERSION} to ${version}`);
		});

		it.each([
			{ name: "missing identity", body: { version: "9999.0.0" } },
			{ name: "foreign package", body: { version: "9999.0.0", packageName: "@foreign/untrusted-cli" } },
			{ name: "unexpected note", body: { version: "9999.0.0", packageName: PACKAGE_NAME, note: "unverified note" } },
			...[
				"npm:foreign@1.2.3",
				"https://example.invalid/install.tgz",
				"1.2.3-beta.1",
				"1.2.3+build",
				"v1.2.3",
				"01.2.3",
				"9007199254740992.0.0",
			].map((version) => ({ name: `unsafe version ${version}`, body: { version, packageName: PACKAGE_NAME } })),
		])("rejects $name even with force and automatic checks disabled", async ({ body }) => {
			vi.stubEnv("DIFFEX_SKIP_VERSION_CHECK", "1");
			const fetchMock = vi.fn(async () => Response.json(body));
			vi.stubGlobal("fetch", fetchMock);

			await runPackageCommandDirectly(["update", "--self", "--force"]);

			expect(process.exitCode).toBe(1);
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(stderr.join("\n")).toContain("Refusing self-update: expected a stable @diffexai/diffex release.");
			expectNoInstallation();
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
				name: "foreign redirect",
				status: 302,
				response: "{}",
				requests: 1,
				message: "Diffex update service is unavailable.",
			},
			{
				name: "exhausted network retries",
				failure: true,
				status: 200,
				response: "{}",
				requests: 3,
				message: "Diffex update service is unavailable: controlled network failure",
			},
		])(
			"reports $name without installation, including force",
			async ({ status, response, requests, message, ...options }) => {
				const fetchMock = vi.fn(async () => {
					if (options.failure) throw new Error("controlled network failure");
					return new Response(response, {
						status,
						headers: {
							"Content-Type": "application/json",
							...(status === 302 ? { Location: "https://unreviewed.invalid/latest" } : {}),
						},
					});
				});
				vi.stubGlobal("fetch", fetchMock);

				await runPackageCommandDirectly(["update", "--self", "--force"]);

				expect(process.exitCode).toBe(1);
				expect(fetchMock).toHaveBeenCalledTimes(requests);
				expect(stderr.join("\n")).toContain(message);
				expectNoInstallation();
			},
		);

		it.each([false, true])("skips manual discovery and installation offline with force=%s", async (force) => {
			vi.stubEnv("DIFFEX_OFFLINE", "1");
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			await runPackageCommandDirectly(["update", "--self", ...(force ? ["--force"] : [])]);

			expect(process.exitCode).toBe(1);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(stderr.join("\n")).toContain("Could not determine latest diffex version.");
			expectNoInstallation();
		});
	});

	it("prints a pnpm metadata hint when self-update fails", async () => {
		const globalRoot = join(tempDir, "pnpm", "global", "v11");
		const selfPackageDir = join(globalRoot, "node_modules", "@diffexai", "diffex");
		const fakeBinDir = join(tempDir, "bin");
		const fakePnpmPath = join(fakeBinDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
		mkdirSync(selfPackageDir, { recursive: true });
		mkdirSync(fakeBinDir, { recursive: true });
		writeFileSync(join(selfPackageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: VERSION }));
		const fakePnpmScript =
			process.platform === "win32"
				? `@echo off\r\nif "%1"=="root" if "%2"=="-g" (echo ${globalRoot} & exit /b 0)\r\nexit /b 23\r\n`
				: `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${globalRoot.replaceAll("'", "'\\''")}'\n\texit 0\nfi\nexit 23\n`;
		writeFileSync(fakePnpmPath, fakePnpmScript);
		chmodSync(fakePnpmPath, 0o755);
		process.env.PATH = `${fakeBinDir}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ""}`;
		process.env.DIFFEX_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(tempDir, "pnpm", "bin", "node"),
			configurable: true,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: getNewerPatchVersion(), packageName: PACKAGE_NAME })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain("Updated diffex");
			expect(stderr).toContain("exited with code 23");
			expect(stderr).toContain("If pnpm reports missing package versions");
			expect(stderr).toContain("Run `pnpm store prune` and retry `diffex update --self`.");
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("reports canonical npm package installation failure without uninstalling", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "pi-coding-agent");
		const fakeNpmPath = join(tempDir, "fake-npm-fail.cjs");
		const recordPath = join(tempDir, "self-update-fail.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) {
	console.log(path.join(prefix,"lib","node_modules"));
	process.exit(0);
}
const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
records.push(args);
fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
if(args.includes("install")) process.exit(23);
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.DIFFEX_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		const activePackageName = PACKAGE_NAME;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ packageName: activePackageName, version: "0.73.0" })),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runPackageCommandDirectly(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain(`Updated diffex`);
			expect(stderr).toContain("exited with code 23");
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([expect.arrayContaining(["install", "-g", `${activePackageName}@0.73.0`])]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated diffex-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
