export const EVOLUTION_MEMORY_MAX_LESSON_SENTENCES = 3;

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const LIST_MARKER_PATTERN = /^(?: {0,3})(?:[-+*]|\d+[.)])[ \t]+/;
const LESSON_NUMBER_PATTERN = /^Lesson[ \t]+\d+[ \t]*:[ \t]*/i;

function normalizedText(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function withoutListMarker(content: string): string {
	return content.replace(LIST_MARKER_PATTERN, "");
}

export function evolutionMemoryLessonBody(content: string): string {
	return withoutListMarker(content).replace(LESSON_NUMBER_PATTERN, "");
}

export function evolutionMemoryLessonContentMatches(left: string, right: string): boolean {
	return (
		left === right ||
		normalizedText(left) === normalizedText(right) ||
		normalizedText(evolutionMemoryLessonBody(left)) === normalizedText(evolutionMemoryLessonBody(right))
	);
}

export function evolutionMemoryLessonNumber(content: string): number | null {
	const match = /^Lesson[ \t]+(\d+)[ \t]*:/i.exec(withoutListMarker(content));
	if (match === null) return null;
	const lessonNumber = Number(match[1]);
	return Number.isSafeInteger(lessonNumber) && lessonNumber >= 1 ? lessonNumber : null;
}

export function assertEvolutionMemoryLessonContent(content: string): void {
	const body = evolutionMemoryLessonBody(content);
	if (body.trim() === "") throw new Error("EVOLVE.md lesson content must be non-empty");
	const sentenceCount = [...sentenceSegmenter.segment(body)].filter((segment) => segment.segment.trim() !== "").length;
	if (sentenceCount > EVOLUTION_MEMORY_MAX_LESSON_SENTENCES) {
		throw new Error(`EVOLVE.md lessons must contain at most ${EVOLUTION_MEMORY_MAX_LESSON_SENTENCES} sentences`);
	}
}

export function numberEvolutionMemoryLesson(content: string, lessonNumber: number): string {
	if (!Number.isSafeInteger(lessonNumber) || lessonNumber < 1) {
		throw new Error("EVOLVE.md lesson number must be a positive integer");
	}
	assertEvolutionMemoryLessonContent(content);
	return `Lesson ${lessonNumber}: ${evolutionMemoryLessonBody(content)}`;
}
