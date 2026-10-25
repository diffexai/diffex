import { posix } from "node:path";

export function packageDependencies(entry) {
	return { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
}

// Node's lookup walks ancestors, but never looks in node_modules/node_modules.
export function resolveExternalDependency(packages, name, from) {
	let directory = from;
	while (true) {
		if (posix.basename(directory) !== "node_modules") {
			const candidate = `${directory ? `${directory}/` : ""}node_modules/${name}`;
			if (packages[candidate] && !packages[candidate].link) return candidate;
		}
		if (!directory) break;
		const parent = posix.dirname(directory);
		directory = parent === "." ? "" : parent;
	}
	throw new Error(`Cannot resolve ${name} from ${from || "root"}`);
}

function assertExactVersion(name, spec, entry, from) {
	if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec) && entry.version !== spec) {
		throw new Error(`${from || "root"} dependency ${name}@${spec} resolves to ${entry.version}`);
	}
}

// The published CLI flattens private workspaces. Resolve its dependencies in those
// workspaces BEFORE relocating them; published paths are not source lookup paths.
export function distributionExternalPackages({ lockPackages, manifest, workspaces, copyEntry }) {
	const origins = new Map();
	const visited = new Set();
	function visit(name) {
		if (visited.has(name)) return;
		visited.add(name);
		const workspace = workspaces.get(name);
		if (!workspace) throw new Error(`Missing internal runtime workspace: ${name}`);
		for (const [dependency, spec] of Object.entries(packageDependencies(workspace.packageJson))) {
			if (workspaces.has(dependency)) visit(dependency);
			else {
				const list = origins.get(dependency) ?? [];
				list.push({ from: workspace.lockPath, spec });
				origins.set(dependency, list);
			}
		}
	}
	visit(manifest.name);
	visit("@diffexai/diffex-evolution");
	visit("@diffexai/diffex-harness-trace");

	function equivalent(left, right, seen = new Set()) {
		if (left === right) return true;
		const pair = `${left}\n${right}`;
		if (seen.has(pair)) return true;
		seen.add(pair);
		if (JSON.stringify(copyEntry(lockPackages[left])) !== JSON.stringify(copyEntry(lockPackages[right])))
			return false;
		return Object.keys(packageDependencies(lockPackages[left])).every((name) =>
			equivalent(
				resolveExternalDependency(lockPackages, name, left),
				resolveExternalDependency(lockPackages, name, right),
				seen,
			),
		);
	}

	const packages = {};
	const sources = new Map();
	const queue = [];
	function add(source, target) {
		packages[target] = copyEntry(lockPackages[source]);
		sources.set(target, source);
		queue.push({ source, target });
	}

	// Reserve all flattened direct dependencies first, independently of traversal order.
	for (const [name, spec] of Object.entries(packageDependencies(manifest)).sort(([a], [b]) => a.localeCompare(b))) {
		const candidates = origins.get(name);
		if (!candidates?.length) throw new Error(`No originating workspace for ${name}`);
		const resolved = candidates.map(({ from, spec: originalSpec }) => {
			if (originalSpec !== spec) throw new Error(`Conflicting bundled runtime dependency: ${name}`);
			const source = resolveExternalDependency(lockPackages, name, from);
			assertExactVersion(name, spec, lockPackages[source], from);
			return source;
		});
		const source = resolved[0];
		for (const candidate of resolved) {
			if (!equivalent(candidate, source)) {
				throw new Error(`Conflicting workspace resolutions for flattened dependency ${name}`);
			}
		}
		add(source, `node_modules/${name}`);
	}

	for (let index = 0; index < queue.length; index++) {
		const { source, target } = queue[index];
		for (const [name, spec] of Object.entries(packageDependencies(lockPackages[source])).sort(([a], [b]) =>
			a.localeCompare(b),
		)) {
			const dependencySource = resolveExternalDependency(lockPackages, name, source);
			assertExactVersion(name, spec, lockPackages[dependencySource], source);
			let existing;
			try {
				existing = resolveExternalDependency(packages, name, target);
			} catch {
				// A new reachable installation location is needed.
			}
			if (existing && sources.get(existing) === dependencySource) continue;
			const rootTarget = `node_modules/${name}`;
			const dependencyTarget =
				!packages[rootTarget] && dependencySource === rootTarget ? rootTarget : `${target}/node_modules/${name}`;
			add(dependencySource, dependencyTarget);
		}
	}

	// Check edges by identity, not just by the existence of a package with that name.
	for (const { source, target } of queue) {
		for (const name of Object.keys(packageDependencies(lockPackages[source]))) {
			const expected = resolveExternalDependency(lockPackages, name, source);
			const actual = resolveExternalDependency(packages, name, target);
			if (sources.get(actual) !== expected) throw new Error(`Relocation changed ${target} dependency ${name}`);
		}
	}
	return packages;
}
