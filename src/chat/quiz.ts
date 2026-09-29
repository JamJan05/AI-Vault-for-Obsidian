/**
 * Quiz parsing for Learn mode.
 *
 * The quiz is JSON written by a model, so it is untrusted input: every field is
 * checked and coerced here, and the renderer only ever sees the normalized shape.
 * Free of Obsidian imports, so it is unit tested as written.
 */

import { t } from "../i18n";

export type QuizQuestionType = "choice" | "truefalse" | "open" | "fill";

export interface QuizQuestion {
	question:    string;
	type:        QuizQuestionType;
	options:     string[];
	/** Index into `options`; only meaningful for choice and truefalse. */
	correct:     number;
	/** Model answer; only meaningful for open and fill. */
	answer:      string;
	explanation: string;
}

export interface Quiz {
	title:     string;
	questions: QuizQuestion[];
}

export interface QuizEvaluation {
	correct:  boolean;
	feedback: string;
}

const MAX_QUESTIONS = 50;
const MAX_OPTIONS   = 10;

const TYPE_ALIASES: Readonly<Record<string, QuizQuestionType>> = {
	choice: "choice", multiple_choice: "choice", single_choice: "choice", mcq: "choice",
	truefalse: "truefalse", true_false: "truefalse", boolean: "truefalse", tf: "truefalse",
	open: "open", short_answer: "open", free_text: "open",
	fill: "fill", fill_blank: "fill", gap: "fill",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value)
		: "";
}

function firstText(...values: unknown[]): string {
	for (const value of values) {
		const text = toText(value);
		if (text) return text;
	}
	return "";
}

function toOptions(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(toText).filter(option => option.length > 0).slice(0, MAX_OPTIONS);
}

function looksLikeTrueFalse(options: string[]): boolean {
	return options.length === 2 && options.every(o => /^(true|false|yes|no)$/i.test(o));
}

function resolveType(raw: Record<string, unknown>, options: string[], answer: string): QuizQuestionType {
	const declared = toText(raw.type).trim().toLowerCase();
	if (TYPE_ALIASES[declared]) return TYPE_ALIASES[declared];
	if (looksLikeTrueFalse(options)) return "truefalse";
	if (options.length) return "choice";
	return answer ? "open" : "choice";
}

/** The correct option as an index, from an index, a boolean, the option text or a letter. */
function resolveCorrect(raw: Record<string, unknown>, options: string[]): number {
	const candidates = [raw.correct, raw.correct_answer, raw.correctAnswer];

	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isInteger(candidate)) {
			if (candidate >= 0 && candidate < options.length) return candidate;
			continue;
		}
		if (typeof candidate === "boolean") {
			// Match the option text: models also write ["False", "True"] or ["No", "Yes"].
			const wanted = candidate ? /^(true|yes)$/i : /^(false|no)$/i;
			const byText = options.findIndex(o => wanted.test(o.trim()));
			if (byText >= 0) return byText;
			const byOrder = candidate ? 0 : 1;
			if (byOrder < options.length) return byOrder;
			continue;
		}
		if (typeof candidate !== "string" || !candidate) continue;

		let index = options.findIndex(o => o === candidate);
		if (index < 0) index = options.findIndex(o => o.toLowerCase() === candidate.toLowerCase());
		if (index < 0 && /^[A-J]$/i.test(candidate)) index = candidate.toUpperCase().charCodeAt(0) - 65;
		if (index >= 0 && index < options.length) return index;
	}
	return 0;
}

export function normalizeQuestion(value: unknown): QuizQuestion | null {
	if (!isRecord(value)) return null;

	let options = toOptions(value.options);
	if (!options.length) options = toOptions(value.answers);
	if (!options.length) options = toOptions(value.choices);

	const declaredAnswer = toText(value.answer);
	const type = resolveType(value, options, declaredAnswer);
	if (type === "truefalse" && !options.length) {
		options = [t("quiz_true_option"), t("quiz_false_option")];
	}

	const isChoice = type === "choice" || type === "truefalse";
	const answer = isChoice
		? declaredAnswer
		: firstText(value.answer, value.correct_answer, value.correctAnswer, value.expected_answer);

	return {
		question:    firstText(value.question, value.text, value.prompt, value.content),
		type,
		options,
		correct:     isChoice ? resolveCorrect(value, options) : 0,
		answer,
		explanation: toText(value.explanation),
	};
}

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Finds a quiz in a model reply: a fenced json block, a bare object with
 * "questions", or the whole reply. Returns null when there is no usable quiz.
 */
export function parseQuiz(content: string): Quiz | null {
	if (typeof content !== "string" || !content.trim()) return null;

	const candidates: string[] = [];
	const fenced = /```json\s*([\s\S]*?)```/.exec(content);
	if (fenced) candidates.push(fenced[1]);
	const bare = /\{[\s\S]*"questions"[\s\S]*\}/.exec(content);
	if (bare) candidates.push(bare[0]);
	candidates.push(content.trim());

	for (const candidate of candidates) {
		const parsed = tryParse(candidate);
		if (!isRecord(parsed) || !Array.isArray(parsed.questions)) continue;

		const questions = parsed.questions
			.slice(0, MAX_QUESTIONS)
			.map(normalizeQuestion)
			.filter((q): q is QuizQuestion => q !== null);
		if (!questions.length) continue;

		return { title: toText(parsed.title), questions };
	}
	return null;
}

/** Exact match, ignoring case and surrounding spaces. */
export function isFillAnswerCorrect(given: string, expected: string): boolean {
	const answer = given.trim().toLowerCase();
	return answer.length > 0 && answer === expected.trim().toLowerCase();
}

/** Reads the grader's `{"correct": …, "feedback": …}` reply. Null when it is not one. */
export function parseQuizEvaluation(text: string): QuizEvaluation | null {
	if (typeof text !== "string") return null;
	const parsed = tryParse(text.replace(/```json|```/g, "").trim());
	if (!isRecord(parsed) || typeof parsed.correct !== "boolean") return null;
	return { correct: parsed.correct, feedback: toText(parsed.feedback) };
}

/** Letter prefix for a choice option: "A. ", "B. ", … */
export function optionPrefix(type: QuizQuestionType, index: number): string {
	return type === "truefalse" ? "" : String.fromCharCode(65 + index) + ". ";
}
