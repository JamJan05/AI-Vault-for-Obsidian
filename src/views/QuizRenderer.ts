import { t } from "../i18n";
import {
	isFillAnswerCorrect,
	optionPrefix,
	parseQuizEvaluation,
} from "../chat/quiz";
import type { Quiz, QuizQuestion } from "../chat/quiz";

/** Sends the grading prompt to the active model and returns its raw reply. */
export type QuizGrader = (prompt: string) => Promise<string>;

function feedback(card: HTMLElement, correct: boolean): HTMLElement {
	return card.createDiv({
		cls: correct ? "gpt-quiz-fb gpt-quiz-fb--ok" : "gpt-quiz-fb gpt-quiz-fb--err",
	});
}

function renderChoice(card: HTMLElement, question: QuizQuestion): void {
	const opts = card.createDiv({ cls: "gpt-quiz-opts" });
	let answered = false;

	question.options.forEach((option, index) => {
		const btn = opts.createEl("button", {
			cls:  "gpt-quiz-opt",
			text: optionPrefix(question.type, index) + option,
		});
		btn.onclick = () => {
			if (answered) return;
			answered = true;

			const correct = index === question.correct;
			opts.querySelectorAll<HTMLButtonElement>(".gpt-quiz-opt").forEach((other, otherIndex) => {
				other.disabled = true;
				if (otherIndex === question.correct) other.addClass("gpt-quiz-opt--correct");
				else if (otherIndex === index && !correct) other.addClass("gpt-quiz-opt--wrong");
			});

			const fb = feedback(card, correct);
			if (correct) {
				fb.appendText(t("quiz_correct") + " ");
				if (question.explanation) fb.appendText(question.explanation);
			} else {
				fb.appendText(t("quiz_wrong_prefix"));
				fb.createEl("strong", {
					text: optionPrefix(question.type, question.correct) + (question.options[question.correct] ?? ""),
				});
				if (question.explanation) {
					fb.createEl("br");
					fb.appendText(question.explanation);
				}
			}
		};
	});
}

function renderWritten(card: HTMLElement, question: QuizQuestion, grade: QuizGrader): void {
	const isFill = question.type === "fill";
	const input = card.createEl("textarea", {
		cls:  "gpt-quiz-input",
		attr: { placeholder: t(isFill ? "quiz_fill_placeholder" : "quiz_open_placeholder"), rows: "2" },
	});
	const checkBtn = card.createEl("button", { cls: "gpt-quiz-check", text: t("quiz_check_btn") });
	let answered = false;

	checkBtn.onclick = async () => {
		if (answered) return;
		const answer = input.value.trim();
		if (!answer) return;

		answered = true;
		input.disabled = true;
		checkBtn.disabled = true;
		checkBtn.textContent = t("quiz_checking");

		if (isFill) {
			const correct = isFillAnswerCorrect(answer, question.answer);
			const fb = feedback(card, correct);
			if (correct) {
				fb.appendText(t("quiz_correct"));
			} else {
				fb.appendText(t("quiz_correct_prefix"));
				fb.createEl("strong", { text: question.answer });
			}
		} else {
			let evaluation = null;
			try {
				evaluation = parseQuizEvaluation(
					await grade(t("quiz_eval_prompt", question.question, question.answer, answer)),
				);
			} catch (e) {
				console.warn("[AI-Vault] quiz grading failed:", (e as Error)?.message);
			}

			if (evaluation) {
				feedback(card, evaluation.correct)
					.appendText((evaluation.correct ? "✅ " : "❌ ") + evaluation.feedback);
			} else {
				feedback(card, false).appendText(t("quiz_eval_error"));
			}
		}
		checkBtn.textContent = t("quiz_check_btn");
	};
}

/**
 * Draws a quiz. Everything from the model is written as text, never as markup,
 * and the quiz has already been normalized by parseQuiz().
 */
export function renderQuiz(container: HTMLElement, quiz: Quiz, grade: QuizGrader): void {
	container.empty();
	if (quiz.title) container.createDiv({ cls: "gpt-quiz-title", text: quiz.title });

	quiz.questions.forEach((question, index) => {
		const card = container.createDiv({ cls: "gpt-quiz-card" });
		card.createDiv({ cls: "gpt-quiz-qnum",  text: t("quiz_progress", index + 1, quiz.questions.length) });
		card.createDiv({ cls: "gpt-quiz-qtext", text: question.question || t("quiz_no_question") });

		const isChoice = question.type === "choice" || question.type === "truefalse";
		if (isChoice && question.options.length) renderChoice(card, question);
		else if (!isChoice) renderWritten(card, question, grade);
	});
}
