/**
 * A quiz is JSON written by a model — untrusted input. The parser has to accept
 * the many shapes models produce and never hand the renderer anything unchecked.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	isFillAnswerCorrect,
	normalizeQuestion,
	optionPrefix,
	parseQuiz,
	parseQuizEvaluation,
} from "../../src/chat/quiz";
import { setLanguage } from "../../src/i18n";

afterEach(() => setLanguage("en"));

const QUIZ = {
	title: "Capitals",
	questions: [
		{ type: "choice", question: "Capital of Poland?", options: ["Kraków", "Warsaw"], correct: 1, explanation: "Since 1596." },
	],
};

describe("parseQuiz", () => {
	it("reads a fenced json block", () => {
		const quiz = parseQuiz("Here you go:\n```json\n" + JSON.stringify(QUIZ) + "\n```\nGood luck!");
		assert.equal(quiz?.title, "Capitals");
		assert.equal(quiz?.questions.length, 1);
		assert.equal(quiz?.questions[0].correct, 1);
	});

	it("reads a bare object inside prose", () => {
		const quiz = parseQuiz("Sure. " + JSON.stringify(QUIZ) + " Done.");
		assert.equal(quiz?.questions[0].question, "Capital of Poland?");
	});

	it("reads a reply that is only JSON", () => {
		assert.equal(parseQuiz(JSON.stringify(QUIZ))?.questions.length, 1);
	});

	it("returns null when there is no quiz", () => {
		for (const text of ["", "   ", "Just a normal answer.", "{}", "[]", "{\"questions\": \"nope\"}", "{\"questions\": []}", "```json\nnot json\n```", "{\"questions\": [1, null, \"x\"]}"]) {
			assert.equal(parseQuiz(text), null, text);
		}
		assert.equal(parseQuiz(undefined as unknown as string), null);
	});

	it("drops entries that are not questions and keeps the rest", () => {
		const quiz = parseQuiz(JSON.stringify({ questions: [null, "text", QUIZ.questions[0], 42] }));
		assert.equal(quiz?.questions.length, 1);
	});

	it("caps the number of questions", () => {
		const many = { questions: Array.from({ length: 200 }, () => QUIZ.questions[0]) };
		assert.equal(parseQuiz(JSON.stringify(many))?.questions.length, 50);
	});

	it("turns a non-string title into text or nothing", () => {
		assert.equal(parseQuiz(JSON.stringify({ ...QUIZ, title: 7 }))?.title, "7");
		assert.equal(parseQuiz(JSON.stringify({ ...QUIZ, title: { a: 1 } }))?.title, "");
	});
});

describe("normalizeQuestion", () => {
	it("rejects anything that is not an object", () => {
		for (const bad of [null, undefined, "text", 5, [], true]) {
			assert.equal(normalizeQuestion(bad), null);
		}
	});

	it("always returns the full shape with safe types", () => {
		const q = normalizeQuestion({ question: { nested: true }, options: "nope", correct: "x", explanation: [] });
		assert.deepEqual(q, { question: "", type: "choice", options: [], correct: 0, answer: "", explanation: "" });
	});

	it("reads the question text from its aliases", () => {
		for (const key of ["question", "text", "prompt", "content"]) {
			assert.equal(normalizeQuestion({ [key]: "What?" })?.question, "What?", key);
		}
	});

	it("maps type aliases", () => {
		const cases: Array<[string, string]> = [
			["multiple_choice", "choice"], ["single_choice", "choice"], ["mcq", "choice"],
			["true_false", "truefalse"], ["boolean", "truefalse"], ["tf", "truefalse"],
			["short_answer", "open"], ["free_text", "open"],
			["fill_blank", "fill"], ["gap", "fill"],
			["CHOICE", "choice"], [" fill ", "fill"],
		];
		for (const [given, expected] of cases) {
			assert.equal(normalizeQuestion({ type: given, options: ["a", "b"] })?.type, expected, given);
		}
	});

	it("infers the type when it is missing or unknown", () => {
		assert.equal(normalizeQuestion({ options: ["True", "False"] })?.type, "truefalse");
		assert.equal(normalizeQuestion({ options: ["yes", "NO"] })?.type, "truefalse");
		assert.equal(normalizeQuestion({ options: ["a", "b", "c"] })?.type, "choice");
		assert.equal(normalizeQuestion({ answer: "42" })?.type, "open");
		assert.equal(normalizeQuestion({ type: "essay", options: ["a", "b"] })?.type, "choice");
	});

	it("reads options from their aliases and turns them into text", () => {
		assert.deepEqual(normalizeQuestion({ answers: ["a", "b"] })?.options, ["a", "b"]);
		assert.deepEqual(normalizeQuestion({ choices: ["a", "b"] })?.options, ["a", "b"]);
		assert.deepEqual(normalizeQuestion({ options: [1, true, "x", null, { o: 1 }] })?.options, ["1", "true", "x"]);
	});

	it("caps the number of options", () => {
		const options = Array.from({ length: 40 }, (_v, i) => `o${i}`);
		assert.equal(normalizeQuestion({ options })?.options.length, 10);
	});

	it("supplies translated options for a true/false question without any", () => {
		assert.deepEqual(normalizeQuestion({ type: "truefalse" })?.options, ["True", "False"]);
		setLanguage("pl");
		assert.deepEqual(normalizeQuestion({ type: "truefalse" })?.options, ["Prawda", "Fałsz"]);
	});

	it("resolves the correct option from an index, a boolean, text or a letter", () => {
		const options = ["Kraków", "Warsaw", "Gdańsk"];
		assert.equal(normalizeQuestion({ options, correct: 2 })?.correct, 2);
		assert.equal(normalizeQuestion({ options, correct_answer: 1 })?.correct, 1);
		assert.equal(normalizeQuestion({ options, correctAnswer: "Warsaw" })?.correct, 1);
		assert.equal(normalizeQuestion({ options, correct_answer: "warsaw" })?.correct, 1);
		assert.equal(normalizeQuestion({ options, correct_answer: "C" })?.correct, 2);
		assert.equal(normalizeQuestion({ options, correct_answer: "b" })?.correct, 1);
		assert.equal(normalizeQuestion({ type: "truefalse", correct_answer: true })?.correct, 0);
		assert.equal(normalizeQuestion({ type: "truefalse", correct_answer: false })?.correct, 1);
	});

	it("resolves a boolean against the option text, whatever the order", () => {
		assert.equal(normalizeQuestion({ options: ["False", "True"], correct_answer: true })?.correct, 1);
		assert.equal(normalizeQuestion({ options: ["False", "True"], correct_answer: false })?.correct, 0);
		assert.equal(normalizeQuestion({ options: ["No", "Yes"], correct: true })?.correct, 1);
		assert.equal(normalizeQuestion({ options: [" yes ", "no"], correct: false })?.correct, 1);
	});

	it("falls back to the usual order when the options are not true and false", () => {
		assert.equal(normalizeQuestion({ options: ["Prawda", "Fałsz"], correct_answer: true })?.correct, 0);
		assert.equal(normalizeQuestion({ options: ["Prawda", "Fałsz"], correct_answer: false })?.correct, 1);
	});

	it("keeps a boolean inside a single-option question", () => {
		assert.equal(normalizeQuestion({ type: "choice", options: ["only"], correct: false })?.correct, 0);
	});

	it("never returns an index outside the options", () => {
		const options = ["a", "b"];
		for (const correct of [5, -1, 1.5, NaN, "Z", "not an option", null, {}]) {
			const q = normalizeQuestion({ options, correct });
			assert.ok(q);
			assert.ok(q.correct >= 0 && q.correct < options.length, String(correct));
		}
	});

	it("reads the model answer of a written question from its aliases", () => {
		assert.equal(normalizeQuestion({ type: "open", answer: "42" })?.answer, "42");
		assert.equal(normalizeQuestion({ type: "open", correct_answer: "42" })?.answer, "42");
		assert.equal(normalizeQuestion({ type: "fill", correctAnswer: 42 })?.answer, "42");
		assert.equal(normalizeQuestion({ type: "fill", expected_answer: "x" })?.answer, "x");
	});
});

describe("isFillAnswerCorrect", () => {
	it("ignores case and surrounding spaces", () => {
		assert.equal(isFillAnswerCorrect("  Warsaw ", "warsaw"), true);
		assert.equal(isFillAnswerCorrect("WARSAW", " Warsaw\n"), true);
	});

	it("rejects a different or an empty answer", () => {
		assert.equal(isFillAnswerCorrect("Kraków", "Warsaw"), false);
		assert.equal(isFillAnswerCorrect("", ""), false);
		assert.equal(isFillAnswerCorrect("   ", "   "), false);
	});
});

describe("parseQuizEvaluation", () => {
	it("reads a plain or fenced reply", () => {
		assert.deepEqual(parseQuizEvaluation('{"correct": true, "feedback": "Yes."}'), { correct: true, feedback: "Yes." });
		assert.deepEqual(parseQuizEvaluation('```json\n{"correct": false, "feedback": "No."}\n```'), { correct: false, feedback: "No." });
	});

	it("tolerates a missing or mistyped feedback", () => {
		assert.deepEqual(parseQuizEvaluation('{"correct": true}'), { correct: true, feedback: "" });
		assert.deepEqual(parseQuizEvaluation('{"correct": true, "feedback": {"a":1}}'), { correct: true, feedback: "" });
	});

	it("returns null unless correct is a real boolean", () => {
		for (const text of ["", "not json", "[]", "null", '{"correct": "true"}', '{"correct": 1}', '{"feedback": "x"}']) {
			assert.equal(parseQuizEvaluation(text), null, text);
		}
		assert.equal(parseQuizEvaluation(undefined as unknown as string), null);
	});
});

describe("optionPrefix", () => {
	it("letters the options of a choice question only", () => {
		assert.equal(optionPrefix("choice", 0), "A. ");
		assert.equal(optionPrefix("choice", 3), "D. ");
		assert.equal(optionPrefix("truefalse", 0), "");
	});
});
