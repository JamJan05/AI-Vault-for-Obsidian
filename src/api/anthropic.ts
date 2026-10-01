import { t } from "../i18n";
import { withRetry } from "../utils";
import { nonRetryableError, parseUsage, requestJson } from "./streaming";
import { buildAnthropicContinuation, buildAnthropicRequest, buildAnthropicToolResults } from "./requests";
import {
	extractAnthropicText,
	readAnthropicContent,
	readAnthropicStopReason,
	readAnthropicToolCalls,
	readServedModel,
} from "./contracts";
import { MAX_TOOL_ROUNDS, joinReplyText, runToolCalls } from "./toolLoop";
import type { ChatMessage } from "../types";
import type { ToolSet } from "../tools/types";
import type { StreamResult, StreamUsage } from "./streaming";

/** Upper bound on resumed turns, so a server that keeps pausing cannot loop forever. */
const MAX_CONTINUATIONS = 3;

function addUsage(total: StreamUsage | null, next: StreamUsage | null): StreamUsage | null {
	if (!next) return total;
	if (!total) return next;
	return {
		input:     total.input + next.input,
		output:    total.output + next.output,
		reasoning: total.reasoning + next.reasoning,
	};
}

/**
 * Calls the Anthropic Claude API through Obsidian requestUrl.
 *
 * Supports:
 * - Thinking — adaptive with an effort level, or a token budget on older models
 * - Web search — a server tool: Anthropic runs the searches on its side
 * - Refusal fallback — a declined request is re-run by Anthropic on another Claude model
 * - Paused turns — a long server-side search is resumed until it completes
 * - Tools — calls the model makes are run by `tools` and answered, round by round
 */
export async function callClaude(
	apiKey:         string,
	model:          string,
	messages:       ChatMessage[],
	mode:           string,
	webSearch       = false,
	onChunk:        ((fullText: string) => void) | null = null,
	signal:         AbortSignal | null = null,
	maxTokens?:     number,
	tools:          ToolSet | null = null,
): Promise<StreamResult> {
	const request = buildAnthropicRequest({
		model, messages, mode, webSearch, maxTokens,
		tools: tools?.definitions,
	});

	const headers: Record<string, string> = {
		"x-api-key":         apiKey,
		"anthropic-version": "2023-06-01",
	};
	if (request.betas.length) headers["anthropic-beta"] = request.betas.join(",");

	let body  = request.body;
	let text  = "";
	let usage: StreamUsage | null = null;
	let servedBy: string | null = null;

	let pauses = 0;
	let rounds = 0;
	// A paused turn continues the same text; a reply after tool results is a new passage.
	let continuing = false;

	for (;;) {
		const current  = body;
		const response = await withRetry(() => requestJson(request.url, headers, current, signal));

		const part = extractAnthropicText(response);
		text     = continuing ? text + (part ?? "") : joinReplyText(text, part);
		usage    = addUsage(usage, parseUsage(response));
		servedBy = readServedModel(response) ?? servedBy;

		const stopReason = readAnthropicStopReason(response);
		if (stopReason === "refusal") throw nonRetryableError(t("err_refusal"));

		if (stopReason === "pause_turn" && pauses < MAX_CONTINUATIONS) {
			pauses++;
			continuing = true;
			body = buildAnthropicContinuation(body, readAnthropicContent(response));
			continue;
		}

		const calls = tools && stopReason === "tool_use" ? readAnthropicToolCalls(response) : [];
		if (!tools || !calls.length || rounds > MAX_TOOL_ROUNDS) break;

		// One round past the limit is answered with refusals, so the model can still finish.
		const results = await runToolCalls(tools, calls, signal, rounds === MAX_TOOL_ROUNDS);
		rounds++;
		continuing = false;
		body = buildAnthropicToolResults(body, readAnthropicContent(response), results);
	}

	text = text.trim();
	if (!text) {
		if (!rounds) throw new Error(t("err_empty_response"));
		text = t("tools_no_final_text");
	}

	onChunk?.(text);
	const result: StreamResult = { text, usage };
	if (servedBy && servedBy !== model && !servedBy.startsWith(`${model}-`)) result.servedBy = servedBy;
	return result;
}
