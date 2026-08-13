import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type TaskProfileOrigin = "builtin" | "package" | "user";

export interface TaskProfileRouting {
	description: string;
	examples: string[];
	keywords: string[];
}

export interface TaskProfileToolPolicy {
	default: string[];
	required: string[];
	denied: string[];
}

export interface TaskProfileGuardrails {
	highStakes: boolean;
	requireHumanReview: boolean;
	requireCurrentSources: boolean;
	disallowedActions: string[];
	instructions: string[];
}

export interface TaskProfileContext {
	fileNames: string[];
	label: string;
}

export interface TaskProfile {
	schemaVersion: 1;
	id: string;
	name: string;
	description: string;
	prompt: string;
	routing: TaskProfileRouting;
	tools: TaskProfileToolPolicy;
	guardrails: TaskProfileGuardrails;
	context: TaskProfileContext;
	promptGuidelines: string[];
	compactionInstructions: string;
}

export interface TaskProfileManifest {
	schemaVersion: 1;
	id: string;
	name: string;
	description: string;
	prompt?: string;
	promptFile?: string;
	routing: TaskProfileRouting;
	tools: TaskProfileToolPolicy;
	guardrails: TaskProfileGuardrails;
	context?: TaskProfileContext;
	promptGuidelines?: string[];
	compactionInstructions?: string;
}

export interface TaskProfileSource {
	path: string;
	label: string;
	promptPath?: string;
}

export interface ResolvedTaskProfile extends TaskProfile {
	origin: TaskProfileOrigin;
	immutable: boolean;
	hash: string;
	source: TaskProfileSource;
}

export interface TaskProfileCollision {
	id: string;
	winnerSource: string;
	loserSource: string;
}

export interface TaskProfileDiagnostic {
	type: "error" | "collision";
	message: string;
	path?: string;
	collision?: TaskProfileCollision;
}

export interface ResolveTaskProfileManifestOptions {
	origin: Exclude<TaskProfileOrigin, "builtin">;
	sourcePath: string;
	sourceLabel?: string;
	baseDir?: string;
}

export interface ResolveTaskProfileManifestResult {
	profile?: ResolvedTaskProfile;
	diagnostics: TaskProfileDiagnostic[];
}

export type TaskProfileLoadInput =
	| string
	| {
			path: string;
			origin?: Exclude<TaskProfileOrigin, "builtin">;
			sourceLabel?: string;
	  }
	| { profile: ResolvedTaskProfile };

export interface TaskProfileLoadResult {
	registry: TaskProfileRegistry;
	profiles: readonly ResolvedTaskProfile[];
	diagnostics: readonly TaskProfileDiagnostic[];
}

export interface ResolveTaskProfileSelectionOptions {
	registry?: TaskProfileRegistry;
	cwd?: string;
	pathOrigin?: Exclude<TaskProfileOrigin, "builtin">;
}

export interface ResolveTaskProfileSelectionResult {
	profile?: ResolvedTaskProfile;
	automatic: boolean;
	registry: TaskProfileRegistry;
	diagnostics: readonly TaskProfileDiagnostic[];
}

const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PROFILE_ID_LENGTH = 64;
const DEFAULT_CONTEXT: TaskProfileContext = {
	fileNames: ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"],
	label: "User instructions",
};

export const BOOTSTRAP_TASK_PROFILE_ID = "general";
export const DEFAULT_TASK_PROFILE_ID = BOOTSTRAP_TASK_PROFILE_ID;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
	value: unknown,
	field: string,
	diagnostics: TaskProfileDiagnostic[],
	path: string,
): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		diagnostics.push({ type: "error", message: `${field} must be a non-empty string`, path });
		return undefined;
	}
	return value;
}

function readStringArray(
	value: unknown,
	field: string,
	diagnostics: TaskProfileDiagnostic[],
	path: string,
): string[] | undefined {
	if (!Array.isArray(value)) {
		diagnostics.push({ type: "error", message: `${field} must be an array of non-empty strings`, path });
		return undefined;
	}

	const result: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			diagnostics.push({ type: "error", message: `${field} must contain only non-empty strings`, path });
			return undefined;
		}
		if (seen.has(entry)) {
			diagnostics.push({ type: "error", message: `${field} contains duplicate value "${entry}"`, path });
			return undefined;
		}
		seen.add(entry);
		result.push(entry);
	}
	return result;
}

function readRouting(
	value: unknown,
	diagnostics: TaskProfileDiagnostic[],
	path: string,
): TaskProfileRouting | undefined {
	if (!isRecord(value)) {
		diagnostics.push({ type: "error", message: "routing must be an object", path });
		return undefined;
	}
	const description = readRequiredString(value.description, "routing.description", diagnostics, path);
	const examples = readStringArray(value.examples, "routing.examples", diagnostics, path);
	const keywords = readStringArray(value.keywords, "routing.keywords", diagnostics, path);
	return description && examples && keywords ? { description, examples, keywords } : undefined;
}

function readTools(
	value: unknown,
	diagnostics: TaskProfileDiagnostic[],
	path: string,
): TaskProfileToolPolicy | undefined {
	if (!isRecord(value)) {
		diagnostics.push({ type: "error", message: "tools must be an object", path });
		return undefined;
	}
	const defaultTools = readStringArray(value.default, "tools.default", diagnostics, path);
	const required = readStringArray(value.required, "tools.required", diagnostics, path);
	const denied = readStringArray(value.denied, "tools.denied", diagnostics, path);
	if (!defaultTools || !required || !denied) return undefined;

	const deniedSet = new Set(denied);
	const conflicts = [...defaultTools, ...required].filter((tool) => deniedSet.has(tool));
	if (conflicts.length > 0) {
		const names = [...new Set(conflicts)].sort().join(", ");
		diagnostics.push({
			type: "error",
			message: `tools policy both enables and denies: ${names}`,
			path,
		});
		return undefined;
	}
	return { default: defaultTools, required, denied };
}

function readGuardrails(
	value: unknown,
	diagnostics: TaskProfileDiagnostic[],
	path: string,
): TaskProfileGuardrails | undefined {
	if (!isRecord(value)) {
		diagnostics.push({ type: "error", message: "guardrails must be an object", path });
		return undefined;
	}
	const booleanFields = ["highStakes", "requireHumanReview", "requireCurrentSources"] as const;
	for (const field of booleanFields) {
		if (typeof value[field] !== "boolean") {
			diagnostics.push({ type: "error", message: `guardrails.${field} must be a boolean`, path });
		}
	}
	const disallowedActions = readStringArray(
		value.disallowedActions,
		"guardrails.disallowedActions",
		diagnostics,
		path,
	);
	const instructions = readStringArray(value.instructions, "guardrails.instructions", diagnostics, path);
	if (
		typeof value.highStakes !== "boolean" ||
		typeof value.requireHumanReview !== "boolean" ||
		typeof value.requireCurrentSources !== "boolean" ||
		!disallowedActions ||
		!instructions
	) {
		return undefined;
	}
	if (value.highStakes && instructions.length === 0) {
		diagnostics.push({
			type: "error",
			message: "high-stakes profiles must provide guardrails.instructions",
			path,
		});
		return undefined;
	}
	return {
		highStakes: value.highStakes,
		requireHumanReview: value.requireHumanReview,
		requireCurrentSources: value.requireCurrentSources,
		disallowedActions,
		instructions,
	};
}

function readContext(
	value: unknown,
	diagnostics: TaskProfileDiagnostic[],
	path: string,
): TaskProfileContext | undefined {
	if (value === undefined) return { fileNames: [...DEFAULT_CONTEXT.fileNames], label: DEFAULT_CONTEXT.label };
	if (!isRecord(value)) {
		diagnostics.push({ type: "error", message: "context must be an object", path });
		return undefined;
	}
	const fileNames = readStringArray(value.fileNames, "context.fileNames", diagnostics, path);
	const label = readRequiredString(value.label, "context.label", diagnostics, path);
	if (fileNames?.some((fileName) => !/^[^/\\]+\.md$/i.test(fileName))) {
		diagnostics.push({
			type: "error",
			message: "context.fileNames must contain Markdown file names without path separators",
			path,
		});
		return undefined;
	}
	return fileNames && label ? { fileNames, label } : undefined;
}

function resolvePrompt(
	manifest: Record<string, unknown>,
	baseDir: string,
	diagnostics: TaskProfileDiagnostic[],
	path: string,
): { prompt: string; promptPath?: string } | undefined {
	const hasPrompt = manifest.prompt !== undefined;
	const hasPromptFile = manifest.promptFile !== undefined;
	if (hasPrompt === hasPromptFile) {
		diagnostics.push({ type: "error", message: "exactly one of prompt or promptFile is required", path });
		return undefined;
	}

	if (hasPrompt) {
		const prompt = readRequiredString(manifest.prompt, "prompt", diagnostics, path);
		return prompt ? { prompt } : undefined;
	}

	const promptFile = readRequiredString(manifest.promptFile, "promptFile", diagnostics, path);
	if (!promptFile) return undefined;
	const promptPath = resolve(baseDir, promptFile);
	const profileDirectory = resolve(baseDir);
	const relativePromptPath = relative(profileDirectory, promptPath);
	if (relativePromptPath === ".." || relativePromptPath.startsWith(`..${sep}`) || isAbsolute(relativePromptPath)) {
		diagnostics.push({
			type: "error",
			message: "promptFile must stay inside the profile directory",
			path: promptPath,
		});
		return undefined;
	}
	try {
		const promptStats = lstatSync(promptPath);
		if (!promptStats.isFile() || promptStats.isSymbolicLink()) {
			diagnostics.push({ type: "error", message: "promptFile is not a file", path: promptPath });
			return undefined;
		}
		const resolvedProfileDirectory = realpathSync(profileDirectory);
		const resolvedPromptPath = realpathSync(promptPath);
		const resolvedRelativePromptPath = relative(resolvedProfileDirectory, resolvedPromptPath);
		if (
			resolvedRelativePromptPath === ".." ||
			resolvedRelativePromptPath.startsWith(`..${sep}`) ||
			isAbsolute(resolvedRelativePromptPath)
		) {
			diagnostics.push({
				type: "error",
				message: "promptFile must resolve inside the profile directory",
				path: promptPath,
			});
			return undefined;
		}
		const prompt = readFileSync(promptPath, "utf-8");
		if (prompt.trim().length === 0) {
			diagnostics.push({ type: "error", message: "promptFile must not be empty", path: promptPath });
			return undefined;
		}
		return { prompt, promptPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read promptFile";
		diagnostics.push({ type: "error", message: `could not read promptFile: ${message}`, path: promptPath });
		return undefined;
	}
}

function profileHashPayload(profile: TaskProfile): Record<string, unknown> {
	return {
		schemaVersion: profile.schemaVersion,
		id: profile.id,
		name: profile.name,
		description: profile.description,
		prompt: profile.prompt,
		routing: {
			description: profile.routing.description,
			examples: profile.routing.examples,
			keywords: profile.routing.keywords,
		},
		tools: {
			default: profile.tools.default,
			required: profile.tools.required,
			denied: profile.tools.denied,
		},
		guardrails: {
			highStakes: profile.guardrails.highStakes,
			requireHumanReview: profile.guardrails.requireHumanReview,
			requireCurrentSources: profile.guardrails.requireCurrentSources,
			disallowedActions: profile.guardrails.disallowedActions,
			instructions: profile.guardrails.instructions,
		},
		context: { fileNames: profile.context.fileNames, label: profile.context.label },
		promptGuidelines: profile.promptGuidelines,
		compactionInstructions: profile.compactionInstructions,
	};
}

export function computeTaskProfileHash(profile: TaskProfile): string {
	return createHash("sha256")
		.update(JSON.stringify(profileHashPayload(profile)))
		.digest("hex");
}

function freezeResolvedProfile(profile: ResolvedTaskProfile): ResolvedTaskProfile {
	Object.freeze(profile.routing.examples);
	Object.freeze(profile.routing.keywords);
	Object.freeze(profile.routing);
	Object.freeze(profile.tools.default);
	Object.freeze(profile.tools.required);
	Object.freeze(profile.tools.denied);
	Object.freeze(profile.tools);
	Object.freeze(profile.guardrails.disallowedActions);
	Object.freeze(profile.guardrails.instructions);
	Object.freeze(profile.guardrails);
	Object.freeze(profile.context.fileNames);
	Object.freeze(profile.context);
	Object.freeze(profile.promptGuidelines);
	Object.freeze(profile.source);
	return Object.freeze(profile);
}

export function resolveTaskProfileManifest(
	value: unknown,
	options: ResolveTaskProfileManifestOptions,
): ResolveTaskProfileManifestResult {
	const diagnostics: TaskProfileDiagnostic[] = [];
	if (!isRecord(value)) {
		return {
			diagnostics: [{ type: "error", message: "profile manifest must be a JSON object", path: options.sourcePath }],
		};
	}
	if (value.schemaVersion !== 1) {
		diagnostics.push({ type: "error", message: "schemaVersion must be 1", path: options.sourcePath });
	}
	const id = readRequiredString(value.id, "id", diagnostics, options.sourcePath);
	if (id && (!PROFILE_ID_PATTERN.test(id) || id.length > MAX_PROFILE_ID_LENGTH)) {
		diagnostics.push({
			type: "error",
			message: `id must be at most ${MAX_PROFILE_ID_LENGTH} characters and contain lowercase letters, numbers, and single hyphens only`,
			path: options.sourcePath,
		});
	}
	const name = readRequiredString(value.name, "name", diagnostics, options.sourcePath);
	const description = readRequiredString(value.description, "description", diagnostics, options.sourcePath);
	const prompt = resolvePrompt(value, options.baseDir ?? dirname(options.sourcePath), diagnostics, options.sourcePath);
	const routing = readRouting(value.routing, diagnostics, options.sourcePath);
	const tools = readTools(value.tools, diagnostics, options.sourcePath);
	const guardrails = readGuardrails(value.guardrails, diagnostics, options.sourcePath);
	const context = readContext(value.context, diagnostics, options.sourcePath);
	const promptGuidelines =
		value.promptGuidelines === undefined
			? []
			: readStringArray(value.promptGuidelines, "promptGuidelines", diagnostics, options.sourcePath);
	const compactionInstructions =
		value.compactionInstructions === undefined
			? "Preserve the user's goal, constraints, verified facts, decisions, artifacts, and pending work."
			: readRequiredString(value.compactionInstructions, "compactionInstructions", diagnostics, options.sourcePath);

	if (
		diagnostics.length > 0 ||
		!id ||
		!PROFILE_ID_PATTERN.test(id) ||
		id.length > MAX_PROFILE_ID_LENGTH ||
		!name ||
		!description ||
		!prompt ||
		!routing ||
		!tools ||
		!guardrails ||
		!context ||
		!promptGuidelines ||
		!compactionInstructions
	) {
		return { diagnostics };
	}

	const taskProfile: TaskProfile = {
		schemaVersion: 1,
		id,
		name,
		description,
		prompt: prompt.prompt,
		routing,
		tools,
		guardrails,
		context,
		promptGuidelines,
		compactionInstructions,
	};
	const resolvedProfile: ResolvedTaskProfile = {
		...taskProfile,
		origin: options.origin,
		immutable: true,
		hash: computeTaskProfileHash(taskProfile),
		source: {
			path: options.sourcePath,
			label: options.sourceLabel ?? `${options.origin}:${basename(options.sourcePath)}`,
			...(prompt.promptPath ? { promptPath: prompt.promptPath } : {}),
		},
	};
	return { profile: freezeResolvedProfile(resolvedProfile), diagnostics };
}

interface BuiltinProfileInput extends TaskProfile {
	sourceLabel: string;
}

function createBuiltinProfile(input: BuiltinProfileInput): ResolvedTaskProfile {
	const { sourceLabel, ...profile } = input;
	return freezeResolvedProfile({
		...profile,
		origin: "builtin",
		immutable: true,
		hash: computeTaskProfileHash(profile),
		source: { path: `<builtin:${profile.id}>`, label: sourceLabel },
	});
}

const SAFE_NON_CODING_TOOLS: TaskProfileToolPolicy = {
	default: ["read", "write", "edit", "update_plan"],
	required: [],
	denied: ["bash"],
};

const STANDARD_GUARDRAILS: TaskProfileGuardrails = {
	highStakes: false,
	requireHumanReview: false,
	requireCurrentSources: false,
	disallowedActions: [],
	instructions: ["Do not claim capabilities, authority, or verification that you do not have."],
};

function highStakesGuardrails(domain: string): TaskProfileGuardrails {
	return {
		highStakes: true,
		requireHumanReview: true,
		requireCurrentSources: true,
		disallowedActions: [
			`Do not make consequential ${domain} decisions on the user's behalf.`,
			"Do not execute transactions, submit forms, or contact third parties without explicit authorization.",
		],
		instructions: [
			"Clearly separate verified facts, assumptions, uncertainty, and general information.",
			"Use current authoritative sources when facts may have changed.",
			"Recommend review by a qualified human before consequential action.",
		],
	};
}

const GENERIC_COMPACTION =
	"Preserve the user's goal, constraints, verified facts, decisions, sources, artifacts, uncertainty, and pending work.";

export const BUILTIN_TASK_PROFILES: readonly ResolvedTaskProfile[] = Object.freeze([
	createBuiltinProfile({
		schemaVersion: 1,
		id: "general",
		name: "General",
		description: "A domain-neutral bootstrap profile for general informational and organizational tasks.",
		prompt:
			"Complete the user's task accurately, concisely, and transparently. Distinguish verified facts from assumptions. For consequential health, legal, financial, or safety matters, use current authoritative sources, surface uncertainty, and recommend qualified review.",
		routing: {
			description: "Use for general tasks that do not clearly require a more specific profile.",
			examples: ["Organize these notes", "Explain this concept", "Draft a concise checklist"],
			keywords: ["general", "organize", "explain", "draft"],
		},
		tools: {
			default: ["read", "bash", "edit", "write"],
			required: [],
			denied: [],
		},
		guardrails: {
			...STANDARD_GUARDRAILS,
			disallowedActions: [],
			instructions: [...STANDARD_GUARDRAILS.instructions],
		},
		context: { fileNames: [...DEFAULT_CONTEXT.fileNames], label: DEFAULT_CONTEXT.label },
		promptGuidelines: ["Be concise and directly address the requested outcome."],
		compactionInstructions: GENERIC_COMPACTION,
		sourceLabel: "Built-in general bootstrap profile",
	}),
	createBuiltinProfile({
		schemaVersion: 1,
		id: "coding",
		name: "Coding",
		description: "Software engineering, debugging, code review, and repository maintenance.",
		prompt:
			"You are an expert software engineering assistant. Inspect the relevant code before editing, make robust maintainable changes, and verify behavior in proportion to risk.",
		routing: {
			description:
				"Use for tasks whose primary deliverable is software, code, configuration, or engineering analysis.",
			examples: ["Fix this failing test", "Implement an API endpoint", "Review this pull request"],
			keywords: ["code", "bug", "repository", "test", "api", "typescript", "python"],
		},
		tools: { default: ["read", "bash", "edit", "write", "update_plan"], required: [], denied: [] },
		guardrails: {
			...STANDARD_GUARDRAILS,
			disallowedActions: [],
			instructions: [...STANDARD_GUARDRAILS.instructions],
		},
		context: {
			fileNames: ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"],
			label: "Project instructions",
		},
		promptGuidelines: [
			"Read relevant files completely before broad changes.",
			"Run focused verification after code changes.",
		],
		compactionInstructions:
			"Preserve the task, implementation decisions, files read and changed, commands run, test results, errors, and pending work.",
		sourceLabel: "Built-in coding profile",
	}),
	createBuiltinProfile({
		schemaVersion: 1,
		id: "finance",
		name: "Finance",
		description: "Financial research, analysis, calculations, and decision support.",
		prompt:
			"Provide careful financial research and analysis. Treat outputs as information, not personalized financial advice. State assumptions, data timestamps, uncertainty, and material risks.",
		routing: {
			description:
				"Use when the primary task concerns investments, markets, accounting, taxes, lending, or financial planning.",
			examples: ["Compare these bond funds", "Analyze this company's cash flow", "Explain the tax assumptions"],
			keywords: ["finance", "investment", "stock", "bond", "tax", "accounting", "loan"],
		},
		tools: {
			default: [...SAFE_NON_CODING_TOOLS.default],
			required: [],
			denied: [...SAFE_NON_CODING_TOOLS.denied],
		},
		guardrails: highStakesGuardrails("financial"),
		context: { fileNames: [...DEFAULT_CONTEXT.fileNames], label: DEFAULT_CONTEXT.label },
		promptGuidelines: ["Include dates for market-sensitive data and expose calculation assumptions."],
		compactionInstructions:
			"Preserve financial assumptions, data sources and timestamps, calculations, positions, risks, uncertainty, and pending verification.",
		sourceLabel: "Built-in finance profile",
	}),
	createBuiltinProfile({
		schemaVersion: 1,
		id: "healthcare",
		name: "Healthcare",
		description: "Health information, clinical research support, and preparation for professional care.",
		prompt:
			"Provide careful health information without presenting it as a diagnosis or substitute for professional care. Surface uncertainty, urgent warning signs, and the need for qualified review when appropriate.",
		routing: {
			description:
				"Use when the primary task concerns symptoms, conditions, medications, treatment, clinical evidence, or healthcare operations.",
			examples: [
				"Summarize these symptoms for my doctor",
				"Compare evidence for these treatments",
				"Explain this lab result",
			],
			keywords: ["health", "medical", "symptom", "medication", "diagnosis", "treatment", "clinical"],
		},
		tools: {
			default: [...SAFE_NON_CODING_TOOLS.default],
			required: [],
			denied: [...SAFE_NON_CODING_TOOLS.denied],
		},
		guardrails: highStakesGuardrails("healthcare"),
		context: { fileNames: [...DEFAULT_CONTEXT.fileNames], label: DEFAULT_CONTEXT.label },
		promptGuidelines: ["Escalate possible emergencies and avoid unsupported diagnostic certainty."],
		compactionInstructions:
			"Preserve reported symptoms, medications, allergies, relevant history, source provenance, uncertainty, warning signs, and escalation status.",
		sourceLabel: "Built-in healthcare profile",
	}),
	createBuiltinProfile({
		schemaVersion: 1,
		id: "legal",
		name: "Legal",
		description: "Legal information, document analysis, issue spotting, and preparation for counsel.",
		prompt:
			"Provide careful legal information, not legal representation or a substitute for qualified counsel. Identify jurisdictional and factual uncertainty, deadlines, and issues requiring professional review.",
		routing: {
			description:
				"Use when the primary task concerns laws, regulations, contracts, disputes, rights, obligations, or legal procedure.",
			examples: [
				"Explain this contract clause",
				"Summarize the relevant regulation",
				"Prepare questions for counsel",
			],
			keywords: ["legal", "law", "contract", "regulation", "court", "rights", "compliance"],
		},
		tools: {
			default: [...SAFE_NON_CODING_TOOLS.default],
			required: [],
			denied: [...SAFE_NON_CODING_TOOLS.denied],
		},
		guardrails: highStakesGuardrails("legal"),
		context: { fileNames: [...DEFAULT_CONTEXT.fileNames], label: DEFAULT_CONTEXT.label },
		promptGuidelines: ["State the relevant jurisdiction and date assumptions whenever they matter."],
		compactionInstructions:
			"Preserve jurisdictions, dates, source authority, material facts, disputed assumptions, deadlines, risks, and questions for counsel.",
		sourceLabel: "Built-in legal profile",
	}),
	createBuiltinProfile({
		schemaVersion: 1,
		id: "research",
		name: "Research",
		description: "Source-grounded research, synthesis, literature review, and evidence analysis.",
		prompt:
			"Conduct source-grounded research. Separate evidence from inference, preserve citations and dates, compare credible perspectives, and call out gaps or uncertainty.",
		routing: {
			description:
				"Use when the primary task requires finding, comparing, or synthesizing evidence from multiple sources.",
			examples: ["Review the literature on this question", "Compare primary sources", "Build an evidence table"],
			keywords: ["research", "sources", "literature", "evidence", "citation", "study"],
		},
		tools: {
			default: [...SAFE_NON_CODING_TOOLS.default],
			required: [],
			denied: [...SAFE_NON_CODING_TOOLS.denied],
		},
		guardrails: {
			...STANDARD_GUARDRAILS,
			requireCurrentSources: true,
			disallowedActions: [],
			instructions: [...STANDARD_GUARDRAILS.instructions],
		},
		context: { fileNames: [...DEFAULT_CONTEXT.fileNames], label: "Research instructions" },
		promptGuidelines: ["Cite primary sources where possible and distinguish evidence from inference."],
		compactionInstructions:
			"Preserve research questions, claims, citations, evidence, source dates, competing interpretations, gaps, uncertainty, and next steps.",
		sourceLabel: "Built-in research profile",
	}),
]);

function createCollisionDiagnostic(
	id: string,
	winner: ResolvedTaskProfile,
	loser: ResolvedTaskProfile,
): TaskProfileDiagnostic {
	return {
		type: "collision",
		message: `profile id "${id}" collision; keeping ${winner.source.path}`,
		path: loser.source.path,
		collision: {
			id,
			winnerSource: winner.source.path,
			loserSource: loser.source.path,
		},
	};
}

function normalizeInjectedProfile(value: unknown): ResolveTaskProfileManifestResult {
	if (!isRecord(value)) {
		return { diagnostics: [{ type: "error", message: "injected profile must be an object" }] };
	}

	const diagnostics: TaskProfileDiagnostic[] = [];
	const source = isRecord(value.source) ? value.source : undefined;
	const sourcePath = source
		? readRequiredString(source.path, "source.path", diagnostics, "<injected-profile>")
		: undefined;
	if (!source) {
		diagnostics.push({ type: "error", message: "source must be an object", path: "<injected-profile>" });
	}
	const validationPath = sourcePath ?? "<injected-profile>";
	const sourceLabel = source
		? readRequiredString(source.label, "source.label", diagnostics, validationPath)
		: undefined;
	let promptPath: string | undefined;
	if (source?.promptPath !== undefined) {
		promptPath = readRequiredString(source.promptPath, "source.promptPath", diagnostics, validationPath);
	}

	const rawOrigin = value.origin;
	const origin: TaskProfileOrigin | undefined =
		rawOrigin === "builtin" || rawOrigin === "package" || rawOrigin === "user" ? rawOrigin : undefined;
	if (!origin) {
		diagnostics.push({
			type: "error",
			message: "injected profile origin must be builtin, package, or user",
			path: validationPath,
		});
	}
	const validationOrigin = origin === "package" ? "package" : "user";
	const resolved = resolveTaskProfileManifest(
		{
			schemaVersion: value.schemaVersion,
			id: value.id,
			name: value.name,
			description: value.description,
			prompt: value.prompt,
			routing: value.routing,
			tools: value.tools,
			guardrails: value.guardrails,
			context: value.context,
			promptGuidelines: value.promptGuidelines,
			compactionInstructions: value.compactionInstructions,
		},
		{
			origin: validationOrigin,
			sourcePath: validationPath,
			sourceLabel,
		},
	);
	diagnostics.push(...resolved.diagnostics);
	if (!resolved.profile || !sourcePath || !sourceLabel || !origin) return { diagnostics };

	if (value.hash !== resolved.profile.hash) {
		diagnostics.push({
			type: "error",
			message: "injected profile hash does not match its contents",
			path: validationPath,
		});
	}
	const expectedImmutable = true;
	if (value.immutable !== expectedImmutable) {
		diagnostics.push({
			type: "error",
			message: "injected profile immutable flag does not match its origin",
			path: validationPath,
		});
	}
	if (diagnostics.length > 0) return { diagnostics };

	if (origin === "builtin") {
		const builtin = BUILTIN_TASK_PROFILES.find(
			(profile) => profile.id === resolved.profile?.id && profile.hash === resolved.profile.hash,
		);
		if (!builtin) {
			return {
				diagnostics: [
					{
						type: "error",
						message: "injected builtin profile does not match a built-in profile",
						path: validationPath,
					},
				],
			};
		}
		return { profile: builtin, diagnostics };
	}

	return {
		profile: freezeResolvedProfile({
			...resolved.profile,
			origin,
			immutable: expectedImmutable,
			source: {
				path: sourcePath,
				label: sourceLabel,
				...(promptPath ? { promptPath } : {}),
			},
		}),
		diagnostics,
	};
}

export class TaskProfileRegistry {
	readonly diagnostics: readonly TaskProfileDiagnostic[];
	private readonly byId: ReadonlyMap<string, ResolvedTaskProfile>;

	constructor(profiles: readonly ResolvedTaskProfile[] = [], diagnostics: readonly TaskProfileDiagnostic[] = []) {
		const byId = new Map<string, ResolvedTaskProfile>();
		const allDiagnostics = [...diagnostics];
		const normalizedProfiles: ResolvedTaskProfile[] = [];
		for (const profile of profiles) {
			const normalized = normalizeInjectedProfile(profile);
			allDiagnostics.push(...normalized.diagnostics);
			if (normalized.profile) normalizedProfiles.push(normalized.profile);
		}
		for (const profile of [...BUILTIN_TASK_PROFILES, ...normalizedProfiles]) {
			const existing = byId.get(profile.id);
			if (existing) {
				if (existing.hash !== profile.hash || existing.source.path !== profile.source.path) {
					allDiagnostics.push(createCollisionDiagnostic(profile.id, existing, profile));
				}
				continue;
			}
			byId.set(profile.id, profile);
		}
		this.byId = byId;
		this.diagnostics = Object.freeze(allDiagnostics);
	}

	get(id: string): ResolvedTaskProfile | undefined {
		return this.byId.get(id);
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	list(): readonly ResolvedTaskProfile[] {
		return Object.freeze([...this.byId.values()]);
	}

	withProfiles(
		profiles: readonly ResolvedTaskProfile[],
		diagnostics: readonly TaskProfileDiagnostic[] = [],
	): TaskProfileRegistry {
		const existingCustom = this.list().filter((profile) => profile.origin !== "builtin");
		return new TaskProfileRegistry([...existingCustom, ...profiles], [...this.diagnostics, ...diagnostics]);
	}
}

function resolveManifestPath(inputPath: string): string {
	const resolvedPath = resolve(inputPath);
	return statSync(resolvedPath).isDirectory() ? join(resolvedPath, "profile.json") : resolvedPath;
}

function loadProfilePath(
	inputPath: string,
	origin: Exclude<TaskProfileOrigin, "builtin">,
	sourceLabel?: string,
): ResolveTaskProfileManifestResult {
	let manifestPath: string;
	try {
		manifestPath = resolveManifestPath(inputPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : "profile path does not exist";
		return { diagnostics: [{ type: "error", message, path: resolve(inputPath) }] };
	}

	try {
		if (!statSync(manifestPath).isFile()) {
			return { diagnostics: [{ type: "error", message: "profile path is not a file", path: manifestPath }] };
		}
		const value: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
		return resolveTaskProfileManifest(value, {
			origin,
			sourcePath: manifestPath,
			sourceLabel,
			baseDir: dirname(manifestPath),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to load profile manifest";
		return {
			diagnostics: [{ type: "error", message: `could not load profile manifest: ${message}`, path: manifestPath }],
		};
	}
}

export function loadTaskProfiles(inputs: readonly TaskProfileLoadInput[] = []): TaskProfileLoadResult {
	const loaded: ResolvedTaskProfile[] = [];
	const loadDiagnostics: TaskProfileDiagnostic[] = [];
	for (const input of inputs) {
		if (typeof input === "object" && "profile" in input) {
			loaded.push(input.profile);
			continue;
		}
		const path = typeof input === "string" ? input : input.path;
		const origin = typeof input === "string" ? "user" : (input.origin ?? "user");
		const sourceLabel = typeof input === "string" ? undefined : input.sourceLabel;
		const result = loadProfilePath(path, origin, sourceLabel);
		if (result.profile) loaded.push(result.profile);
		loadDiagnostics.push(...result.diagnostics);
	}
	const registry = new TaskProfileRegistry(loaded, loadDiagnostics);
	return { registry, profiles: registry.list(), diagnostics: registry.diagnostics };
}

function looksLikePath(selection: string): boolean {
	return (
		isAbsolute(selection) ||
		selection.startsWith(".") ||
		selection.includes("/") ||
		selection.includes("\\") ||
		selection.endsWith(".json")
	);
}

export function resolveTaskProfileSelection(
	selection: string | undefined,
	options: ResolveTaskProfileSelectionOptions = {},
): ResolveTaskProfileSelectionResult {
	const registry = options.registry ?? new TaskProfileRegistry();
	const normalized = selection?.trim();
	if (!normalized || normalized === "auto") {
		return { automatic: true, registry, diagnostics: registry.diagnostics };
	}

	const byId = registry.get(normalized);
	if (byId) {
		return { profile: byId, automatic: false, registry, diagnostics: registry.diagnostics };
	}

	const candidatePath = resolve(options.cwd ?? process.cwd(), normalized);
	if (!existsSync(candidatePath)) {
		const message = looksLikePath(normalized)
			? `profile path does not exist: ${candidatePath}`
			: `unknown profile id: ${normalized}`;
		const diagnostic: TaskProfileDiagnostic = { type: "error", message, path: candidatePath };
		return { automatic: false, registry, diagnostics: Object.freeze([...registry.diagnostics, diagnostic]) };
	}

	const loaded = loadTaskProfiles([
		{ path: candidatePath, origin: options.pathOrigin ?? "user", sourceLabel: `selected:${normalized}` },
	]);
	const selectedCustom = loaded.profiles.find((profile) => profile.origin !== "builtin");
	if (!selectedCustom) {
		return {
			automatic: false,
			registry,
			diagnostics: Object.freeze([...registry.diagnostics, ...loaded.diagnostics]),
		};
	}
	const derivedRegistry = registry.withProfiles([selectedCustom], loaded.diagnostics);
	const winner = derivedRegistry.get(selectedCustom.id);
	const profile = winner?.hash === selectedCustom.hash ? winner : undefined;
	return {
		...(profile ? { profile } : {}),
		automatic: false,
		registry: derivedRegistry,
		diagnostics: derivedRegistry.diagnostics,
	};
}
