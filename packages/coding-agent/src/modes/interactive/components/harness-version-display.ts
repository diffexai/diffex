import { type EvolutionHarnessVersionInfo, parseEvolutionMemoryBlocks } from "#evolution";

export function sanitizeDisplayText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

export function formatEvolutionTimestamp(value: string | null, now = new Date()): string {
	if (value === null) return "never";
	const checkpoint = new Date(value);
	if (!Number.isFinite(checkpoint.getTime())) return sanitizeDisplayText(value);
	const hours = checkpoint.getHours();
	const time = `${hours % 12 || 12}:${checkpoint.getMinutes().toString().padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
	const isToday =
		checkpoint.getFullYear() === now.getFullYear() &&
		checkpoint.getMonth() === now.getMonth() &&
		checkpoint.getDate() === now.getDate();
	return isToday ? `Today at ${time}` : `${checkpoint.getMonth() + 1}/${checkpoint.getDate()} at ${time}`;
}

export function formatHarnessVersionLabel(
	info: EvolutionHarnessVersionInfo,
	currentVersion: string | null | undefined,
	now = new Date(),
): string {
	const current = info.version === currentVersion ? "[current] " : "";
	if (info.kind === "default") return `${current}Default Diffex Agent`;

	const evolvedAt = info.evolvedAt === null ? "" : ` ${formatEvolutionTimestamp(info.evolvedAt, now)}`;
	const evolvedIn = info.evolvedIn === null ? "" : `: ${sanitizeDisplayText(info.evolvedIn)}`;
	const origin = info.origin === "skill" ? " [skill activation]" : "";
	return `${current}Evolved Diffex Agent${evolvedAt}${evolvedIn}${origin}`;
}

export function countHarnessMemoryLessons(memory: string): number | undefined {
	try {
		return parseEvolutionMemoryBlocks(memory).filter((block) =>
			/^(?: {0,3}(?:[-+*]|\d+[.)])[ \t]+)?Lesson[ \t]+[1-9]\d*[ \t]*:/i.test(block.content),
		).length;
	} catch {
		return undefined;
	}
}

export function formatHarnessVersionInventory(memory: string | undefined, skillCount: number | undefined): string {
	const lessons = memory === undefined ? "?" : (countHarnessMemoryLessons(memory) ?? "?");
	return `${lessons} lessons · ${skillCount ?? "?"} skills`;
}

export function formatHarnessVersionPickerLabel(
	info: EvolutionHarnessVersionInfo,
	currentVersion: string | null | undefined,
	memory: string | undefined,
	skillCount: number | undefined,
	now = new Date(),
): string {
	const hash = sanitizeDisplayText(info.version.replace(/^sha256:/, "").slice(0, 12));
	const timestamp = Number.isFinite(Date.parse(info.evolvedAt ?? ""))
		? formatEvolutionTimestamp(info.evolvedAt, now)
		: "unknown time";
	const current = info.version === currentVersion ? " [current]" : "";
	return `${timestamp} · ${formatHarnessVersionInventory(memory, skillCount)} · ${hash}${current}`;
}

export function formatHarnessVersionReference(
	version: string | null,
	versionInfo: readonly EvolutionHarnessVersionInfo[],
	currentVersion: string | null | undefined,
	fallback?: EvolutionHarnessVersionInfo,
	now = new Date(),
): string {
	if (version === null) return "none";
	const info = versionInfo.find((candidate) => candidate.version === version) ?? fallback;
	return info === undefined ? "Diffex Agent" : formatHarnessVersionLabel(info, currentVersion, now);
}
