import { readFileSync } from "node:fs";

export interface DiffexManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	profiles?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes", "profiles"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readDiffexManifest(packageJsonPath: string): DiffexManifest | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isObject(pkg) || !isObject(pkg.diffex)) {
			return null;
		}

		const manifest: DiffexManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.diffex[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
