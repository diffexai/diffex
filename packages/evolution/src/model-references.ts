import type { JsonObject } from "./contracts.ts";

export type EvolutionModelReferenceKind = "document" | "evidence" | "instruction" | "lesson" | "memory" | "slice";

const REFERENCE_PREFIXES: Readonly<Record<EvolutionModelReferenceKind, string>> = {
	document: "D",
	evidence: "E",
	instruction: "I",
	lesson: "L",
	memory: "M",
	slice: "S",
};

export interface EvolutionModelReferenceEntry<T> {
	readonly ref: string;
	readonly value: T;
}

export class EvolutionModelReferenceError extends Error {
	readonly field: string;
	readonly invalidReferences: readonly string[];
	readonly permittedReferences: readonly string[];

	constructor(
		field: string,
		invalidReferences: readonly string[],
		permittedReferences: readonly string[],
		reason: string,
	) {
		super(`${field} ${reason}. Permitted references: ${permittedReferences.join(", ") || "none"}`);
		this.name = "EvolutionModelReferenceError";
		this.field = field;
		this.invalidReferences = invalidReferences;
		this.permittedReferences = permittedReferences;
	}
}

export class EvolutionModelReferenceCatalog<T> {
	readonly #kind: EvolutionModelReferenceKind;
	#entries: readonly EvolutionModelReferenceEntry<T>[];
	#valuesByReference: ReadonlyMap<string, T>;

	constructor(kind: EvolutionModelReferenceKind, values: readonly T[], firstIndex = 1) {
		if (!Number.isSafeInteger(firstIndex) || firstIndex < 0) throw new Error("firstIndex must be non-negative");
		this.#kind = kind;
		this.#entries = values.map((value, index) => ({
			ref: `${REFERENCE_PREFIXES[kind]}${firstIndex + index}`,
			value,
		}));
		this.#valuesByReference = new Map(this.#entries.map((entry) => [entry.ref, entry.value]));
	}

	get kind(): EvolutionModelReferenceKind {
		return this.#kind;
	}

	get entries(): readonly EvolutionModelReferenceEntry<T>[] {
		return this.#entries;
	}

	get references(): readonly string[] {
		return this.#entries.map((entry) => entry.ref);
	}

	refFor(value: T): string {
		const entry = this.#entries.find((candidate) => candidate.value === value);
		if (entry === undefined) throw new Error(`Value is absent from the ${this.#kind} reference catalog`);
		return entry.ref;
	}

	resolve(ref: string, field: string): T {
		const value = this.#valuesByReference.get(ref);
		if (value === undefined) {
			throw new EvolutionModelReferenceError(field, [ref], this.references, "contains an unknown reference");
		}
		return value;
	}

	select(values: readonly T[]): EvolutionModelReferenceCatalog<T> {
		const permitted = new Set(values);
		const entries = this.#entries.filter((entry) => permitted.has(entry.value));
		const selected = new EvolutionModelReferenceCatalog<T>(this.#kind, []);
		selected.#entries = entries;
		selected.#valuesByReference = new Map(entries.map((entry) => [entry.ref, entry.value]));
		return selected;
	}

	resolutionMap(canonical: (value: T) => string): JsonObject {
		return Object.fromEntries(this.#entries.map((entry) => [entry.ref, canonical(entry.value)]));
	}
}

export function referenceArray<T>(
	value: unknown,
	field: string,
	catalog: EvolutionModelReferenceCatalog<T>,
	allowEmpty = true,
): readonly T[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new EvolutionModelReferenceError(field, [], catalog.references, "must be an array of references");
	}
	const references = value as readonly string[];
	const duplicates = references.filter((reference, index) => references.indexOf(reference) !== index);
	if (duplicates.length > 0) {
		throw new EvolutionModelReferenceError(
			field,
			[...new Set(duplicates)],
			catalog.references,
			"contains duplicates",
		);
	}
	if (!allowEmpty && references.length === 0) {
		throw new EvolutionModelReferenceError(field, [], catalog.references, "must not be empty");
	}
	const invalid = references.filter((reference) => !catalog.references.includes(reference));
	if (invalid.length > 0) {
		throw new EvolutionModelReferenceError(field, invalid, catalog.references, "contains an unknown reference");
	}
	return references.map((reference) => catalog.resolve(reference, field));
}
