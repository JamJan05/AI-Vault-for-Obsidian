import { THINKING_MODES } from "../models";
import { withRetry } from "../utils";
import { streamSSE } from "./streaming";
import type { ChatMessage } from "../types";
import type { StreamResult } from "./streaming";

/**
 * Calls the Anthropic Claude API via SSE streaming.
 *
 * Supports:
 * - Extended thinking (mode === "think") — budget_tokens from cfg
 * - Web search — server tool web_search_20260209 (Anthropic runs the searches on its side)
 *
 * Note: anthropic-dangerous-direct-browser-access is required when the
 * request goes directly from the browser (Obsidian desktop/mobile).
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
		stream:     true,
	};

	if (isThinking) {
		body.thinking = { type: "enabled", budget_tokens: tokens };
	}

	// Web search — server tool: Anthropic runs the searches on its side.
	// One request, one stream — no agentic loop needed.
	if (webSearch) {
		body.tools = [{ type: "web_search_20260209", name: "web_search" }];
	}

	return withRetry(() =>
		streamSSE(
			"https://api.anthropic.com/v1/messages",
			{
				"x-api-key":                                  apiKey,
				"anthropic-version":                          "2023-06-01",
				"anthropic-dangerous-direct-browser-access":  "true",
			},
			body,
			(event) => {
				// Extract only text_delta — ignore thinking_delta (internal reasoning)
				if (
					event.type === "content_block_delta" &&
					(event.delta as { type?: string } | undefined)?.type === "text_delta"
				) {
					return (event.delta as { text?: string }).text ?? null;
				}
				return null;
			},
			onChunk,
			signal,
		),
	);
}
