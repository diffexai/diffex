import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSelfUpdateCommand } from "../src/config.ts";
import { getSelfUpdateFailureHints, runSelfUpdate, SelfUpdateError } from "../src/utils/self-update.ts";

describe("self-update output and diagnostics", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "diffex-self-update-"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	function manager(name: string, script: string) {
		const file = join(directory, `${name}.cjs`);
		const command = join(directory, process.platform === "win32" ? `${name}.cmd` : name);
		writeFileSync(file, script);
		writeFileSync(
			command,
			process.platform === "win32"
				? `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`
				: `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${file.replaceAll("'", "'\\''")}' "$@"\n`,
		);
		chmodSync(command, 0o755);
		return {
			command,
			args: ["install", "-g", "@diffexai/diffex@1.2.3"],
			display: `${command} install -g @diffexai/diffex@1.2.3`,
		};
	}

	function output(interactive: boolean) {
		const stdout: string[] = [];
		const stderr: string[] = [];
		return {
			stdout,
			stderr,
			streams: {
				stdout: { write: (text: string) => stdout.push(text), isTTY: interactive, columns: 80 },
				stderr: { write: (text: string) => stderr.push(text) },
			},
		};
	}

	it.each(["npm", "pnpm"])("shows one activity line for interactive %s, preserving warnings", async (name) => {
		const command = manager(
			name,
			'console.log("Progress: resolved 200, downloaded 200"); console.error("WARN deprecated fixture");',
		);
		const capture = output(true);
		await runSelfUpdate(command, capture.streams);
		expect(capture.stdout.join("")).toContain(`Downloading and installing with ${name}`);
		expect(capture.stdout.join("")).not.toContain("resolved 200");
		expect(capture.stdout.join("")).not.toContain("100%");
		expect(capture.stdout.at(-1)).toBe("\r\u001b[2K");
		expect(capture.stderr.join("")).toContain("WARN deprecated fixture");
	});

	it("streams native output without terminal escapes when redirected", async () => {
		const command = manager("npm", 'console.log("added 3 packages"); console.error("npm warn fixture");');
		const capture = output(false);
		await runSelfUpdate(command, capture.streams);
		expect(capture.stdout.join("")).toContain("added 3 packages");
		expect(capture.stderr.join("")).toContain("npm warn fixture");
		expect(capture.stdout.join("")).not.toContain("\u001b");
	});

	it("preserves configured wrapper output even in a terminal", async () => {
		const command = manager("custom-wrapper", 'console.log("wrapper diagnostic");');
		const capture = output(true);
		await runSelfUpdate(command, capture.streams);
		// Wrapper output goes directly to its inherited streams, not through our renderer.
		expect(capture.stdout.join("")).toBe("Running custom-wrapper...\n");
		expect(capture.stdout.join("")).not.toContain("\u001b");
	});

	it("replays a bounded diagnostic tail after a failed interactive installation", async () => {
		const command = manager(
			"npm",
			'process.stdout.write("x".repeat(40000)); console.error("npm error ENOTEMPTY fixture"); process.exitCode = 23;',
		);
		const capture = output(true);
		const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
		let failure: unknown;
		try {
			await runSelfUpdate(command, capture.streams);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SelfUpdateError);
		expect((failure as SelfUpdateError).message).toContain("exited with code 23");
		expect((failure as SelfUpdateError).output.length).toBeLessThanOrEqual(32 * 1024);
		expect(capture.stderr.join("")).toContain("npm error ENOTEMPTY fixture");
		expect(capture.stderr.join("").length).toBeLessThanOrEqual(32 * 1024 + 1);
		expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
	});

	it("clears progress and reports spawn failures", async () => {
		const capture = output(true);
		await expect(
			runSelfUpdate({ command: join(directory, "missing", "npm"), args: [], display: "npm" }, capture.streams),
		).rejects.toThrow("Could not start npm");
		expect(capture.stdout.at(-1)).toBe("\r\u001b[2K");
	});

	it("does not run later steps after a failed installation", async () => {
		const fail = manager("npm", "process.exitCode = 23;");
		const next = manager("pnpm", 'throw new Error("must not run");');
		const capture = output(false);
		await expect(runSelfUpdate({ ...fail, steps: [fail, next] }, capture.streams)).rejects.toThrow(
			"exited with code 23",
		);
		expect(capture.stdout.join("")).not.toContain("with pnpm");
	});

	it.each([
		{ failure: "EINTEGRITY", renamed: false },
		{ failure: "ECONNRESET", renamed: false },
		{ failure: "EINTEGRITY", renamed: true },
		{ failure: "ECONNRESET", renamed: true },
		{ failure: undefined, renamed: false },
		{ failure: undefined, renamed: true },
	])(
		"validates the native npm target before replacement ($failure, renamed=$renamed)",
		async ({ failure, renamed }) => {
			const prefix = join(directory, "prefix with spaces");
			const installedName = renamed ? "@mariozechner/pi-coding-agent" : "@diffexai/diffex";
			const packageDir = join(prefix, "lib", "node_modules", ...installedName.split("/"));
			const sentinel = join(packageDir, "sentinel");
			const records = join(directory, "commands.jsonl");
			mkdirSync(packageDir, { recursive: true });
			writeFileSync(sentinel, "existing installation");
			manager(
				"npm",
				`const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("root")) {
 console.log(${JSON.stringify(join(prefix, "lib", "node_modules"))});
 process.exit(0);
}
fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify(args) + "\\n");
if (args.includes("cache") && ${JSON.stringify(failure ?? "")}) {
 console.error("npm error " + ${JSON.stringify(failure ?? "")});
 process.exit(23);
}
if (args.includes("install") || args.includes("uninstall")) fs.writeFileSync(${JSON.stringify(sentinel)}, "replacement started");
`,
			);
			vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH ?? ""}`);
			vi.stubEnv("DIFFEX_PACKAGE_DIR", packageDir);
			const descriptor = Object.getOwnPropertyDescriptor(process, "execPath");
			Object.defineProperty(process, "execPath", { value: join(packageDir, "dist", "cli.js"), configurable: true });
			try {
				const command = getSelfUpdateCommand(installedName, undefined, {
					packageName: "@diffexai/diffex",
					installSpec: "@diffexai/diffex@1.2.3",
				});
				expect(command).toBeDefined();
				if (!command) throw new Error("Expected a native npm update command");
				const capture = output(false);
				if (failure) {
					await expect(runSelfUpdate(command, capture.streams)).rejects.toThrow("exited with code 23");
					expect(capture.stderr.join("")).toContain(failure);
					expect(readFileSync(sentinel, "utf8")).toBe("existing installation");
				} else {
					await runSelfUpdate(command, capture.streams);
					expect(readFileSync(sentinel, "utf8")).toBe("replacement started");
				}
				const cache = [
					"--prefix",
					prefix,
					"cache",
					"add",
					"--ignore-scripts",
					"--min-release-age=0",
					"@diffexai/diffex@1.2.3",
				];
				const install = [
					"--prefix",
					prefix,
					"install",
					"-g",
					"--ignore-scripts",
					"--min-release-age=0",
					"@diffexai/diffex@1.2.3",
				];
				const uninstall = ["--prefix", prefix, "uninstall", "-g", installedName];
				expect(
					readFileSync(records, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
				).toEqual(failure ? [cache] : renamed ? [cache, uninstall, install] : [cache, install]);
			} finally {
				if (descriptor) Object.defineProperty(process, "execPath", descriptor);
			}
		},
	);

	it.each([
		["ENOTEMPTY", "move only the Diffex package directory"],
		["EACCES", "not writable"],
		["EPERM", "not writable"],
		["EBADENGINE", "Node.js 22.19.0"],
		["ERR_PNPM_UNSUPPORTED_ENGINE", "Node.js 22.19.0"],
		["ENOSPC", "disk is full"],
		["ERR_PNPM_NO_GLOBAL_BIN_DIR", "pnpm setup"],
		["ERR_PNPM_NO_MATCHING_VERSION", "mirror refreshes"],
		["ETARGET", "mirror refreshes"],
		["EINTEGRITY", "do not disable integrity checks"],
		["ERR_PNPM_TARBALL_INTEGRITY", "do not disable integrity checks"],
		["ECONNRESET", "network, proxy"],
		["ERR_PNPM_META_FETCH_FAIL", "network, proxy"],
	])("provides a targeted recovery hint for %s", (code, expected) => {
		expect(getSelfUpdateFailureHints(new SelfUpdateError("install failed", code)).join("\n")).toContain(expected);
	});

	it("does not suggest pruning caches for unrelated pnpm failures", () => {
		expect(getSelfUpdateFailureHints(new SelfUpdateError("pnpm exited with code 23", "unrelated failure"))).toEqual(
			[],
		);
	});
});
