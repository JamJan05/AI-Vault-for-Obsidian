/**
 * Assembles the system prompt from its parts.
 *
 * This is the text that carries note content to a provider, so it is a pure
 * function with its limits in one place, and it is unit tested as written.
 */

import { t } from "../i18n";
import { noteToolsPrompt } from "../tools/noteTools";
import type { NoteToolsPromptOptions } from "../tools/noteTools";

export type ChatMode = "chat" | "learn" | "code";

/** The assembled prompt is cut at this length. */
export const MAX_SYSTEM_CHARS = 120_000;
/** Each attached note is cut at this length. */
export const ATTACHED_NOTE_CHARS = 3000;

export interface NoteExcerpt {
	title: string;
	text:  string;
}

export interface SystemPromptParts {
	/** The project's prompt when it has one, otherwise the global one. */
	basePrompt: string;
	chatMode:   ChatMode;
	/** Notes the user attached, with the notes they link to. */
	attached:   NoteExcerpt[];
	/** Fragments found by RAG. */
	retrieved:  NoteExcerpt[];
	/** The vault was searched for this question and nothing related was found. */
	searchedWithoutMatch?: boolean;
	project:    { name: string; context: string } | null;
	/** Set while the model is offered the note tools; says how changes are approved. */
	noteTools?: NoteToolsPromptOptions | null;
}

const SEPARATOR = "\n\n---\n\n";

function codeModePrompt(): string {
	return t("code_system_prompt_intro") +
		t("code_rules_header") +
		t("code_rule_clean") +
		t("code_rule_1") + t("code_rule_2") + t("code_rule_3") +
		t("code_rule_4") +
		t("code_rule_format") +
		t("code_rule_flag") +
		t("code_rule_5") + t("code_system_prompt_closing");
}

function section(header: string, body: string): string {
	return `\n\n---\n${header}\n\n${body}\n---`;
}

export function composeSystemPrompt(parts: SystemPromptParts): string {
	let prompt = parts.chatMode === "code" ? codeModePrompt() : parts.basePrompt;
	if (parts.chatMode === "learn") prompt += t("quiz_instruction");
	if (parts.noteTools) prompt += noteToolsPrompt(parts.noteTools);

	if (parts.attached.length) {
		const body = parts.attached
			.map(note => `### ${note.title}\n${note.text.slice(0, ATTACHED_NOTE_CHARS)}`)
			.join(SEPARATOR);
		prompt += section(t("rag_manual_ctx_header"), body);
	}

	if (parts.retrieved.length) {
		const body = parts.retrieved
			.map(note => `### ${note.title}\n${note.text}`)
			.join(SEPARATOR);
		prompt += section("VAULT CONTEXT (RAG):", body);
	}

	// Say so plainly, so the model can explain it instead of claiming it sees nothing.
	// With the note tools the model can look for itself, so the note would be wrong.
	if (parts.searchedWithoutMatch && !parts.retrieved.length && !parts.attached.length && !parts.noteTools) {
		prompt += `\n\n---\n${t("rag_no_match_note")}\n---`;
	}

	if (parts.project?.context) {
		prompt += section(t("rag_project_ctx_header", parts.project.name), parts.project.context);
	}

	if (prompt.length > MAX_SYSTEM_CHARS) {
		prompt = prompt.slice(0, MAX_SYSTEM_CHARS) + "\n\n" + t("rag_ctx_truncated");
	}
	return prompt;
}
