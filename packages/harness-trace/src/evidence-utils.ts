import type { MaterializedCausalIdentifier } from "./materialized-types.ts";

function isIdentifierName(name: string): boolean {
	return name === "id" || name.endsWith("Id") || name.endsWith(".id") || name.endsWith("_id");
}

function collectCausalIdentifiers(value: unknown, prefix = "", result = new Map<string, string>()): void {
	if (Array.isArray(value)) {
		for (const item of value) collectCausalIdentifiers(item, prefix, result);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [name, item] of Object.entries(value)) {
		const qualifiedName = prefix ? `${prefix}.${name}` : name;
		if (typeof item === "string" && isIdentifierName(name)) result.set(`${qualifiedName}\0${item}`, item);
		else collectCausalIdentifiers(item, qualifiedName, result);
	}
}

export function causalIdentifiers(...values: readonly unknown[]): readonly MaterializedCausalIdentifier[] {
	const identifiers = new Map<string, string>();
	for (const value of values) collectCausalIdentifiers(value, "", identifiers);
	return [...identifiers.entries()]
		.map(([key, value]) => ({ name: key.slice(0, key.indexOf("\0")), value }))
		.sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
}
