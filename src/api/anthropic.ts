import { THINKING_MODES } from "../models";
import { withRetry } from "../utils";
import { requestCompletion } from "./streaming";
import { extractAnthropicText } from "./contracts";
import type { ChatMessage } from "../types";
import type { StreamResult } from "./streaming";

/**
 * Calls the Anthropic Claude API through Obsidian requestUrl.
 *
 * Supports:
 * - Extended thinking (mode === "think") — budget_tokens from cfg
 * - Web search — server tool web_search_20260209 (Anthropic runs the searches on its side)
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
	const cfg        = THINKING_MODES[mode] ?? THINKING_MODES.normal;
	const tokens     = maxTokens ?? cfg.tokens;
	const isThinking = mode === "think";

	const systemMsg = messages.find(m => m.role === "system");
	const inputMsgs = messages
		.filter(m => m.role !== "system")
		.map(m => ({ role: m.role, content: m.content }));

	const body: Record<string, unknown> = {
		model,
		max_tokens: isThinking ? tokens + 8000 : tokens,
		system:     systemMsg?.content ?? undefined,
		messages:   inputMsgs,
		stream:     false,
	};

	if (isThinking) {
		body.thinking = { type: "enabled", budget_tokens: tokens };
	}

	// Web search — server tool: Anthropic runs the searches on its side.
	// Anthropic runs the search within the same request.
	if (webSearch) {
		body.tools = [{ type: "web_search_20260209", name: "web_search" }];
	}

	return withRetry(() =>
		requestCompletion(
			"https://api.anthropic.com/v1/messages",
			{
				"x-api-key":         apiKey,
				"anthropic-version": "2023-06-01",
			},
			body,
			extractAnthropicText,
			onChunk,
			signal,
		),
	);
}
