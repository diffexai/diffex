import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Optional test reports may live in the checkout or in the system temporary directory.
export function writeGoalReport(output: string, content: string, append = false): void {
	const repository = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
	const temporary = realpathSync(tmpdir());
	const path = resolve(output);
	const lexicalTemporary = resolve(tmpdir());
	if (!path.startsWith(repository + sep) && !path.startsWith(lexicalTemporary + sep)) {
		throw new Error("Goal report output must be inside the repository or system temporary directory");
	}
	let ancestor = path;
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	const physical = realpathSync(ancestor);
	if (
		physical !== repository &&
		!physical.startsWith(repository + sep) &&
		physical !== temporary &&
		!physical.startsWith(temporary + sep)
	) {
		throw new Error("Goal report output must not escape through a symbolic link");
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, { flag: append ? "a" : "w", mode: 0o600 });
}
