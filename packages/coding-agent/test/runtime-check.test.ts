import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("CLI Node requirement diagnostic", () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "diffex-node-check-"));
	});
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it.each([
		["20.19.0", false],
		["22.18.0", false],
		["22.19.0", true],
		["22.20.0", true],
		["24.0.0", true],
	])("checks runtime metadata %s before application dependencies", (version, supported) => {
		const preload = join(directory, "runtime-version.mjs");
		writeFileSync(preload, `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`);
		const result = spawnSync(
			process.execPath,
			["--import", preload, fileURLToPath(new URL("../src/runtime-check.ts", import.meta.url))],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(supported ? 0 : 1);
		if (supported) expect(result.stderr).toBe("");
		else {
			expect(result.stderr).toContain(`Diffex requires Node.js 22.19.0 or newer (found ${version})`);
			expect(result.stderr).toContain("same package manager and prefix");
			expect(result.stderr).not.toContain("at ");
		}
	});

	it("keeps the CLI guard aligned with the published Node engine", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			engines: { node: string };
		};
		expect(manifest.engines.node).toBe(">=22.19.0");
		const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
		expect(cli.indexOf('import "./runtime-check.ts"')).toBeLessThan(cli.indexOf('from "./main.ts"'));
	});
});
