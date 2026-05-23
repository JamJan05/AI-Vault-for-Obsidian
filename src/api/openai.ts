import { t } from "../i18n";
import { THINKING_MODES, isGPT5, isGPT5Search, mapEffortForGPT5, WEB_SEARCH_CAPABLE } from "../models";
import { withRetry } from "../utils";
import { streamSSE, throwHttpError } from "./streaming";
import type { ChatMessage } from "../types";
import type { StreamResult, StreamUsage } from "./streaming";

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
			stream: true,
			stream_options: { include_usage: true },
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
			stream: true,
			stream_options: { include_usage: true },
		};
	} else {
		// GPT-4o, GPT-4-turbo and other classic models
		body = {
			model,
			messages: chatMessages,
			max_tokens: tokens,
			stream: true,
			stream_options: { include_usage: true },
		};
		if (webSearch && WEB_SEARCH_CAPABLE.has(model)) {
			body.tools = [{ type: "web_search" }];
		}
	}

	return withRetry(() =>
		streamSSE(
			"https://api.openai.com/v1/chat/completions",
			{ "Authorization": `Bearer ${apiKey}` },
			body,
			(event) => {
				const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
				return choices?.[0]?.delta?.content ?? null;
			},
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
		stream:            true,
	};

	return withRetry(async () => {
		// NOTE: Using fetch() for Responses API SSE streaming as requestUrl() doesn't support streaming.
		// This requires isDesktopOnly: true in manifest.json.
		const response = await fetch("https://api.openai.com/v1/responses", {
			method:  "POST",
			headers: {
				"Content-Type":  "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body:   JSON.stringify(body),
			signal: signal ?? undefined,
		});

		if (!response.ok) await throwHttpError(response, model);

		const reader  = response.body!.getReader();
		const decoder = new TextDecoder();
		let fullText = "";
		let buffer   = "";
		let finished = false;
		let chunksDelivered = false;
		let usage: StreamUsage | null = null;

		const abortError = (): Error => {
			const e = new Error("Aborted by user");
			e.name = "AbortError";
			return e;
		};

		try {
			while (!finished) {
				if (signal?.aborted) throw abortError();
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (signal?.aborted) throw abortError();
					if (!line.startsWith("data: ")) continue;
					const data = line.slice(6).trim();
					if (data === "[DONE]") { finished = true; break; }

					let event: Record<string, unknown>;
					try { event = JSON.parse(data) as Record<string, unknown>; }
					catch { continue; }

					// Responses API stream events:
					// response.output_text.delta → response text
					// response.completed         → usage including reasoning tokens
					if (event.type === "response.output_text.delta") {
						const delta = (event.delta as string) ?? "";
						if (delta) {
							fullText += delta;
							chunksDelivered = true;
							onChunk?.(fullText);
						}
					} else if (event.type === "response.completed") {
						const r = event.response as {
							usage?: {
								input_tokens?: number;
								output_tokens?: number;
								output_tokens_details?: { reasoning_tokens?: number };
							};
						} | undefined;
						if (r?.usage) {
							usage = {
								input:     r.usage.input_tokens  ?? 0,
								output:    r.usage.output_tokens ?? 0,
								reasoning: r.usage.output_tokens_details?.reasoning_tokens ?? 0,
							};
						}
					} else if (event.type === "error" || event.error) {
						const err = event.error as { message?: string } | undefined;
						throw new Error(err?.message ?? (event.message as string) ?? t("err_stream_responses"));
					}
				}
			}
		} catch (err) {
			if (chunksDelivered && (err as { name?: string }).name !== "AbortError") {
				(err as { noRetry?: boolean }).noRetry = true;
			}
			throw err;
		} finally {
			if (!finished) {
				try { await reader.cancel(); } catch { /* ignore */ }
			}
		}

		if (!fullText.trim()) throw new Error(t("err_empty_response"));
		return { text: fullText.trim(), usage };
	});
}
