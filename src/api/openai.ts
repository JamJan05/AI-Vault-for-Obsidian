import { t } from "../i18n";
import { withRetry } from "../utils";
import { parseUsage, requestCompletion, requestJson } from "./streaming";
import { buildOpenAIRequest, buildOpenAIToolResults } from "./requests";
import {
	extractOpenAIChatText,
	extractOpenAIResponsesCitations,
	extractOpenAIResponsesText,
	formatCitations,
	readOpenAIOutput,
	readOpenAIToolCalls,
} from "./contracts";
import { MAX_TOOL_ROUNDS, joinReplyText, runToolCalls } from "./toolLoop";
import type { ChatMessage } from "../types";
import type { StreamResult, StreamUsage } from "./streaming";
import type { ToolSet } from "../tools/types";

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
 * buildOpenAIRequest. Calls the model makes to `tools` are run and answered,
 * round by round, until it gives its answer.
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
	tools:      ToolSet | null = null,
): Promise<StreamResult> {
	const request = buildOpenAIRequest({
		model, messages, mode, webSearch, maxTokens,
		tools: tools?.definitions,
	});
	if (tools) return runWithTools(apiKey, request.url, request.body, tools, onChunk, signal);

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

function addUsage(total: StreamUsage | null, next: StreamUsage | null): StreamUsage | null {
	if (!next) return total;
	if (!total) return next;
	return {
		input:     total.input + next.input,
		output:    total.output + next.output,
		reasoning: total.reasoning + next.reasoning,
	};
}

/** Responses API exchange in which the model may call tools before it answers. */
async function runWithTools(
	apiKey:  string,
	url:     string,
	first:   Record<string, unknown>,
	tools:   ToolSet,
	onChunk: ((fullText: string) => void) | null,
	signal:  AbortSignal | null,
): Promise<StreamResult> {
	const headers = { "Authorization": `Bearer ${apiKey}` };

	let body   = first;
	let text   = "";
	let usage: StreamUsage | null = null;
	let rounds = 0;

	for (;;) {
		const current  = body;
		const response = await withRetry(() => requestJson(url, headers, current, signal));

		text  = joinReplyText(text, extractResponsesTextWithSources(response));
		usage = addUsage(usage, parseUsage(response));

		const calls = readOpenAIToolCalls(response);
		if (!calls.length || rounds > MAX_TOOL_ROUNDS) break;

		// One round past the limit is answered with refusals, so the model can still finish.
		const results = await runToolCalls(tools, calls, signal, rounds === MAX_TOOL_ROUNDS);
		rounds++;
		body = buildOpenAIToolResults(body, readOpenAIOutput(response), results);
	}

	if (!text) {
		if (!rounds) throw new Error(t("err_empty_response"));
		text = t("tools_no_final_text");
	}

	onChunk?.(text);
	return { text, usage };
}
