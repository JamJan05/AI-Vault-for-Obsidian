import { THINKING_MODES, isGPT5, isGPT5Search, mapEffortForGPT5, WEB_SEARCH_CAPABLE } from "../models";
import { withRetry } from "../utils";
import { requestCompletion } from "./streaming";
import { extractOpenAIChatText, extractOpenAIResponsesText } from "./contracts";
import type { ChatMessage } from "../types";
import type { StreamResult } from "./streaming";

// ─── Chat Completions ─────────────────────────────────────────────────────────

/**
 * Calls the OpenAI API.
 * Automatically picks the endpoint:
 * - GPT-5 + webSearch → Responses API (only way to use web search with these models)
 * - GPT-5 without webSearch → Chat Completions with reasoning_effort
 * - GPT-5-search-api → Chat Completions with web_search_options
 * - Others → Chat Completions, optionally tools:[{type:"web_search"}]
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
	const cfg      = THINKING_MODES[mode] ?? THINKING_MODES.normal;
	const tokens   = maxTokens ?? cfg.tokens;
	const gpt5     = isGPT5(model);
	const gpt5Srch = isGPT5Search(model);

	// GPT-5/Mini/Nano + web search → Responses API
	if (gpt5 && webSearch) {
		return callOpenAIResponses(apiKey, model, messages, mode, onChunk, signal, maxTokens);
	}

	const systemMsg = messages.find(m => m.role === "system");
	const userMsgs  = messages.filter(m => m.role !== "system");

	const chatMessages: { role: string; content: string }[] = [];
	if (systemMsg?.content) chatMessages.push({ role: "system", content: systemMsg.content });
	chatMessages.push(...userMsgs.map(m => ({ role: m.role, content: m.content })));

	let body: Record<string, unknown>;

	if (gpt5Srch) {
		// gpt-5-search-api: built-in web search via Chat Completions, web_search_options param
		body = {
			model,
			messages: chatMessages,
			max_tokens: tokens,
			web_search_options: {},
				stream: false,
		};
	} else if (gpt5) {
		// GPT-5/Mini/Nano without web search — Chat Completions with reasoning_effort
		const effort = mapEffortForGPT5(mode);
		const tokenBudget =
			effort === "high"   ? tokens + 12000 :
			effort === "medium" ? tokens + 4000  :
			tokens;

		body = {
			model,
			messages: chatMessages,
			max_completion_tokens: tokenBudget,
			reasoning_effort: effort,
				stream: false,
		};
	} else {
		// GPT-4o, GPT-4-turbo and other classic models
		body = {
			model,
			messages: chatMessages,
			max_tokens: tokens,
				stream: false,
		};
		if (webSearch && WEB_SEARCH_CAPABLE.has(model)) {
			body.tools = [{ type: "web_search" }];
		}
	}

	return withRetry(() =>
		requestCompletion(
			"https://api.openai.com/v1/chat/completions",
			{ "Authorization": `Bearer ${apiKey}` },
			body,
			extractOpenAIChatText,
			onChunk,
			signal,
		),
	);
}

// ─── Responses API (GPT-5 + web search) ──────────────────────────────────────

/**
 * OpenAI Responses API — used exclusively for GPT-5/Mini/Nano with web search.
 * Different endpoint and format than Chat Completions — handles reasoning + web search in one stream.
 */
export async function callOpenAIResponses(
	apiKey:     string,
	model:      string,
	messages:   ChatMessage[],
	mode:       string,
	onChunk:    ((fullText: string) => void) | null = null,
	signal:     AbortSignal | null = null,
	maxTokens?: number,
): Promise<StreamResult> {
	const cfg    = THINKING_MODES[mode] ?? THINKING_MODES.normal;
	const tokens = maxTokens ?? cfg.tokens;
	const effort = mapEffortForGPT5(mode);
	const tokenBudget =
		effort === "high"   ? tokens + 12000 :
		effort === "medium" ? tokens + 4000  :
		tokens;

	const systemMsg = messages.find(m => m.role === "system");
	const userMsgs  = messages.filter(m => m.role !== "system");

	// Responses API uses `input` instead of `messages`, `instructions` instead of `system`
	const input = userMsgs.map(m => ({
		type: "message",
		role: m.role,
		content: [{
			type: m.role === "user" ? "input_text" : "output_text",
			text: m.content,
		}],
	}));

	const body = {
		model,
		input,
		instructions:      systemMsg?.content ?? undefined,
		max_output_tokens: tokenBudget,
		reasoning:         { effort },
		tools:             [{ type: "web_search" }],
		stream:            false,
	};

	return withRetry(() => requestCompletion(
		"https://api.openai.com/v1/responses",
		{ "Authorization": `Bearer ${apiKey}` },
		body,
		extractOpenAIResponsesText,
		onChunk,
		signal,
	));
}
