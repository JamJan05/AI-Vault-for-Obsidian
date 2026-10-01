/**
 * One-line summary of what the next message will send, and to whom.
 *
 * Shown above the input so the destination of note text is visible before the
 * user presses Send. Free of Obsidian imports, so it is unit tested as written.
 */

import { RAG_TOP_K } from "../constants";
import { t } from "../i18n";
import { assessLocalBaseUrl } from "../security/urlPolicy";
import type { Provider } from "../settings";

export interface SendSummaryInput {
	provider:      Provider;
	localBaseUrl:  string;
	/** RAG is on and an index is loaded, so note fragments will be attached. */
	ragActive:     boolean;
	/** Semantic search is on, so the question is also sent to OpenAI for embedding. */
	semanticActive: boolean;
	attachedNotes: number;
	webSearch:     boolean;
	projectActive: boolean;
	/** 0 means the whole conversation. */
	historyLimit:  number;
	/** The model may read and change notes with tools during this message. */
	noteTools?:    boolean;
	/** Changes are written without asking. Only meaningful with `noteTools`. */
	autoApply?:    boolean;
	/** Only notes marked with #name in a message can be changed. */
	requireMark?:  boolean;
	/** A mark also covers the notes the marked note links to. */
	followLinks?:  boolean;
}

export interface SendSummary {
	text:    string;
	/** True when the destination deserves a warning colour (plaintext to a remote host). */
	warning: boolean;
}

function describeDestination(input: SendSummaryInput): { name: string; warning: boolean } {
	if (input.provider === "openai")    return { name: "OpenAI", warning: false };
	if (input.provider === "anthropic") return { name: "Anthropic", warning: false };

	const assessment = assessLocalBaseUrl(input.localBaseUrl);
	if (!assessment.usable || !assessment.hostname) {
		return { name: t("send_summary_local"), warning: false };
	}
	if (assessment.isLoopback) {
		return { name: t("send_summary_this_device", assessment.hostname), warning: false };
	}
	return {
		name:    assessment.hostname,
		warning: assessment.verdict === "remote-http",
	};
}

export function describeOutgoing(input: SendSummaryInput): SendSummary {
	const destination = describeDestination(input);

	const items: string[] = [t("send_summary_message")];
	items.push(input.historyLimit > 0
		? t("send_summary_history_limit", input.historyLimit)
		: t("send_summary_history_all"));
	if (input.attachedNotes > 0) items.push(t("send_summary_attached", input.attachedNotes));
	if (input.ragActive)         items.push(t("send_summary_rag", RAG_TOP_K));
	if (input.projectActive)     items.push(t("send_summary_project"));
	if (input.webSearch && input.provider !== "local") items.push(t("send_summary_web"));

	let text = t("send_summary_line", destination.name, items.join(", "));
	if (destination.warning) text += " " + t("send_summary_unencrypted");

	// The embedding request goes to OpenAI whatever the chat provider is.
	if (input.ragActive && input.semanticActive && input.provider !== "openai") {
		text += " " + t("send_summary_embedding");
	}

	// Local models are not offered the tools, whatever the switch says.
	const noteTools = Boolean(input.noteTools) && input.provider !== "local";
	const autoApply = noteTools && Boolean(input.autoApply);
	if (noteTools) {
		text += " " + t(autoApply ? "send_summary_tools_auto" : "send_summary_tools_confirm", destination.name);
		if (input.requireMark) {
			text += " " + t(input.followLinks ? "send_summary_tools_marked_links" : "send_summary_tools_marked");
		}
	}

	return { text, warning: destination.warning || autoApply };
}
