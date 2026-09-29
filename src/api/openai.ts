import { t } from "../i18n";
import { withRetry } from "../utils";
import { requestCompletion } from "./streaming";
import { buildOpenAIRequest } from "./requests";
import {
	extractOpenAIChatText,
	extractOpenAIResponsesCitations,
	extractOpenAIResponsesText,
	formatCitations,
} from "./contracts";
import type { ChatMessage } from "../types";
import type { StreamResult } from "./streaming";

/**
 * Responses API text plus the web sources the answer did not link itself, so
 * every cited page stays visible and clickable in the rendered message.
 */
function extractResponsesTextWithSources(response: Record<string, unknown>): string | null {
	const text = extractOpenAIResponsesText(response);
	if (!text) return text;
	const citations = extractOpenAIResponsesCitations(response);
	return text + formatCitations(text, citations, t("ws_sources_label"));
}

/**
 * Calls the OpenAI API through Obsidian requestUrl.
 * The endpoint and the request shape come from the model catalogue — see
 * buildOpenAIRequest.
 */
export async function callOpenAI(
	apiKey:     string,
	model:      string,
	messages:   ChatMessage[],
	mode:       string,
	webSearch   = false,
	onChunk:    ((fullText: string) => void) | null = null,
	signal:     AbortSignal | null = null,
	maxTokens?: number,
): Promise<StreamResult> {
	const request = buildOpenAIRequest({ model, messages, mode, webSearch, maxTokens });
	const extract = request.endpoint === "responses"
		? extractResponsesTextWithSources
		: extractOpenAIChatText;

	return withRetry(() =>
		requestCompletion(
			request.url,
			{ "Authorization": `Bearer ${apiKey}` },
			request.body,
			extract,
			onChunk,
			signal,
		),
	);
}
