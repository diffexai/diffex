import { closeSync, constants, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Optional test reports may live in the checkout or in the system temporary directory.
export function writeGoalReport(output: string, content: string, append = false): void {
	const repository = realpathSync(fileURLToPath(new URL("../../../../", import.meta.url)));
	const temporary = resolve(tmpdir());
	const path = resolve(output);
	const root = path.startsWith(repository + sep) ? repository : temporary;
	if (!path.startsWith(root + sep)) {
		throw new Error("Goal report output must be inside the repository or system temporary directory");
	}
	const physicalRoot = realpathSync(root);
	let directory = physicalRoot;
	for (const component of relative(root, dirname(path)).split(sep).filter(Boolean)) {
		if (component === "." || component === "..") throw new Error("Invalid report directory component");
		const next = join(directory, basename(component));
		mkdirSync(next, { recursive: true });
		directory = realpathSync(next);
		if (!directory.startsWith(physicalRoot + sep)) {
			throw new Error("Goal report output must not escape through a symbolic link");
		}
	}
	const descriptor = openSync(
		join(directory, basename(path)),
		constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (append ? constants.O_APPEND : constants.O_TRUNC),
		0o600,
	);
	try {
		writeFileSync(descriptor, content);
	} finally {
		closeSync(descriptor);
	}
}
