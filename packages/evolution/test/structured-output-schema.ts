const UNSUPPORTED_CODEX_SCHEMA_KEYWORDS = new Set([
	"allOf",
	"const",
	"dependentRequired",
	"dependentSchemas",
	"else",
	"if",
	"not",
	"oneOf",
	"then",
	"uniqueItems",
]);

export function findUnsupportedCodexSchemaKeywords(schema: unknown): readonly string[] {
	const found = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		for (const [key, child] of Object.entries(value)) {
			if (UNSUPPORTED_CODEX_SCHEMA_KEYWORDS.has(key)) found.add(key);
			visit(child);
		}
	};
	visit(schema);
	return [...found].sort();
}
