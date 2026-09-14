import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const codingAgent = "@diffexai/diffex";

export function testCommands(group = "all", args = []) {
	if (group === "coding-agent") return [["test", `--workspace=${codingAgent}`, "--", ...args]];
	if (args.length > 0) throw new Error("Only the coding-agent group accepts Vitest arguments.");
	if (group === "all") return [["test"]];
	if (group !== "other") throw new Error(`Unknown test group: ${group}. Use all, coding-agent, or other.`);

	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const workspaces = globSync(manifest.workspaces.map((pattern) => `${pattern}/package.json`), { cwd: root })
		.map((path) => JSON.parse(readFileSync(resolve(root, path), "utf8")))
		.filter((workspace) => workspace.scripts?.test && workspace.name !== codingAgent)
		.map((workspace) => `--workspace=${workspace.name}`)
		.sort();
	if (workspaces.length === 0) throw new Error("No other test workspaces found.");
	return [["run", "test:scripts"], ["test", ...workspaces]];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [group, ...args] = process.argv.slice(2);
	for (const command of testCommands(group, args)) {
		const result = spawnSync("npm", command, {
			cwd: root,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
}
