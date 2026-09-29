import { t } from "../i18n";
import { withRetry } from "../utils";
import { nonRetryableError, parseUsage, requestJson } from "./streaming";
import { buildAnthropicContinuation, buildAnthropicRequest } from "./requests";
import {
	extractAnthropicText,
	readAnthropicContent,
	readAnthropicStopReason,
	readServedModel,
} from "./contracts";
import type { ChatMessage } from "../types";
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
): Promise<StreamResult> {
	const request = buildAnthropicRequest({ model, messages, mode, webSearch, maxTokens });

	const headers: Record<string, string> = {
		"x-api-key":         apiKey,
		"anthropic-version": "2023-06-01",
	};
	if (request.betas.length) headers["anthropic-beta"] = request.betas.join(",");

	let body  = request.body;
	let text  = "";
	let usage: StreamUsage | null = null;
	let servedBy: string | null = null;

	for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
		const current  = body;
		const response = await withRetry(() => requestJson(request.url, headers, current, signal));

		text    += extractAnthropicText(response) ?? "";
		usage    = addUsage(usage, parseUsage(response));
		servedBy = readServedModel(response) ?? servedBy;

		const stopReason = readAnthropicStopReason(response);
		if (stopReason === "refusal") throw nonRetryableError(t("err_refusal"));
		if (stopReason !== "pause_turn") break;

		body = buildAnthropicContinuation(body, readAnthropicContent(response));
	}

	text = text.trim();
	if (!text) throw new Error(t("err_empty_response"));

	onChunk?.(text);
	const result: StreamResult = { text, usage };
	if (servedBy && servedBy !== model && !servedBy.startsWith(`${model}-`)) result.servedBy = servedBy;
	return result;
}
