/**
 * Request builders for the cloud providers.
 *
 * Deliberately free of Obsidian imports and of credentials: these functions only
 * turn a conversation into a request body, so the exact payload that leaves the
 * device can be unit tested. API keys are attached by the callers.
 */

import {
	THINKING_MODES,
	normalizeThinkingMode,
	resolveAnthropicProfile,
	resolveOpenAIProfile,
} from "../models";
import type { Effort } from "../models";
import type { ChatMessage } from "../types";
import type { ToolDefinition, ToolResult } from "../tools/types";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const OPENAI_CHAT_URL      = "https://api.openai.com/v1/chat/completions";
export const ANTHROPIC_URL        = "https://api.anthropic.com/v1/messages";

export const ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type OpenAIEndpoint = "responses" | "chat-completions";

export interface RequestOptions {
	model:      string;
	messages:   ChatMessage[];
	mode:       string;
	webSearch?: boolean;
	maxTokens?: number;
	/** Functions the model may ask the plugin to run. Omitted or empty: none. */
	tools?:     readonly ToolDefinition[];
}

export interface OpenAIRequest {
	endpoint: OpenAIEndpoint;
	url:      string;
	body:     Record<string, unknown>;
}

export interface AnthropicRequest {
	url:   string;
	/** Values for the `anthropic-beta` header; empty when no beta feature is used. */
	betas: string[];
	body:  Record<string, unknown>;
}

/** Extra thinking budget for Claude models that still take `budget_tokens`. */
const BUDGET_THINKING_HEADROOM = 8000;
/** Anthropic rejects a thinking budget below this. */
const MIN_THINKING_BUDGET = 1024;

/**
 * Reasoning tokens are billed against the output limit, so the limit is padded to
 * keep the reasoning from eating the visible answer.
 */
export function padTokensForEffort(tokens: number, effort: Effort | null): number {
	switch (effort) {
		case "high":   return tokens + 12000;
		case "medium": return tokens + 4000;
		case "low":    return tokens + 2000;
		default:       return tokens;
	}
}

function resolveTokens(mode: string, maxTokens?: number): number {
	const cfg = THINKING_MODES[mode] ?? THINKING_MODES.normal;
	return maxTokens ?? cfg.tokens;
}

function splitSystem(messages: ChatMessage[]): { system: string | null; turns: ChatMessage[] } {
	const system = messages.find(m => m.role === "system")?.content ?? "";
	return {
		system: system ? system : null,
		turns:  messages.filter(m => m.role !== "system"),
	};
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

/**
 * Picks the endpoint and builds the body for an OpenAI model.
 * - Reasoning models always use the Responses API.
 * - Classic models use Chat Completions, except with web search, which only the
 *   Responses API offers as a tool, and with note tools, so that one code path
 *   handles tool calls for every model.
 */
export function buildOpenAIRequest(options: RequestOptions): OpenAIRequest {
	const profile   = resolveOpenAIProfile(options.model);
	const mode      = normalizeThinkingMode(options.mode);
	const tokens    = resolveTokens(options.mode, options.maxTokens);
	const webSearch = Boolean(options.webSearch) && profile.webSearch;
	const { system, turns } = splitSystem(options.messages);
	const tools     = options.tools ?? [];

	if (profile.effortByMode === null && !webSearch && !tools.length) {
		const chatMessages: { role: string; content: string }[] = [];
		if (system) chatMessages.push({ role: "system", content: system });
		chatMessages.push(...turns.map(m => ({ role: m.role, content: m.content })));

		return {
			endpoint: "chat-completions",
			url:      OPENAI_CHAT_URL,
			body: {
				model:      options.model,
				messages:   chatMessages,
				max_tokens: tokens,
			},
		};
	}

	let effort: Effort | null = profile.effortByMode ? profile.effortByMode[mode] : null;
	// Search results are only as good as the reasoning that reads them.
	if (webSearch && effort === "none") effort = "low";

	const body: Record<string, unknown> = {
		model: options.model,
		input: turns.map(m => ({
			type:    "message",
			role:    m.role,
			content: [{
				type: m.role === "user" ? "input_text" : "output_text",
				text: m.content,
			}],
		})),
		max_output_tokens: padTokensForEffort(tokens, effort),
		// The Responses API keeps responses for 30 days unless told otherwise.
		// Conversations belong on the user's machine, so storage is always declined.
		store: false,
	};
	if (system) body.instructions = system;
	if (effort) body.reasoning = { effort };

	const requestTools: unknown[] = [];
	if (webSearch) requestTools.push({ type: "web_search" });
	for (const tool of tools) {
		requestTools.push({
			type:        "function",
			name:        tool.name,
			description: tool.description,
			parameters:  tool.parameters,
			strict:      true,
		});
	}
	if (requestTools.length) body.tools = requestTools;

	// Nothing is stored on OpenAI's side, so the reasoning that led to a tool call
	// has to travel back with the tool results. It comes encrypted, on request.
	if (tools.length && profile.effortByMode !== null) body.include = ["reasoning.encrypted_content"];

	return { endpoint: "responses", url: OPENAI_RESPONSES_URL, body };
}

/**
 * Body for answering the function calls of a Responses API reply: the same
 * request with the reply's output items and one result per call appended.
 */
export function buildOpenAIToolResults(
	body:    Record<string, unknown>,
	output:  unknown[],
	results: ToolResult[],
): Record<string, unknown> {
	const input = Array.isArray(body.input) ? (body.input as unknown[]) : [];
	return {
		...body,
		input: [
			...input,
			...output,
			...results.map(result => ({
				type:    "function_call_output",
				call_id: result.id,
				output:  result.content,
			})),
		],
	};
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

export function buildAnthropicRequest(options: RequestOptions): AnthropicRequest {
	const profile = resolveAnthropicProfile(options.model);
	const mode    = normalizeThinkingMode(options.mode);
	const tokens  = resolveTokens(options.mode, options.maxTokens);
	const { system, turns } = splitSystem(options.messages);

	const body: Record<string, unknown> = {
		model:    options.model,
		messages: turns.map(m => ({ role: m.role, content: m.content })),
	};
	if (system) body.system = system;

	if (profile.thinking === "adaptive") {
		const configured = profile.effortByMode ? profile.effortByMode[mode] : "medium";
		// Claude has no "none" level; "low" is its shallowest setting.
		const effort: Effort = configured === "none" ? "low" : configured;
		body.thinking      = { type: "adaptive" };
		body.output_config = { effort };
		body.max_tokens    = padTokensForEffort(tokens, effort);
	} else if (mode === "think") {
		// The token limit is a user setting and may be lower than the API accepts.
		const budget    = Math.max(MIN_THINKING_BUDGET, tokens);
		body.thinking   = { type: "enabled", budget_tokens: budget };
		body.max_tokens = budget + BUDGET_THINKING_HEADROOM;
	} else {
		body.max_tokens = tokens;
	}

	const requestTools: unknown[] = (options.tools ?? []).map(tool => ({
		name:         tool.name,
		description:  tool.description,
		input_schema: tool.parameters,
	}));
	if (options.webSearch && profile.webSearchTool) {
		// Server tool: Anthropic runs the searches on its side, within the same request.
		requestTools.push({ type: profile.webSearchTool, name: "web_search" });
	}
	if (requestTools.length) body.tools = requestTools;

	const betas: string[] = [];
	if (profile.refusalFallback) {
		// A request declined by a safety classifier is re-run by Anthropic on another
		// Claude model, so the user gets an answer instead of an empty refusal.
		body.fallbacks = "default";
		betas.push(ANTHROPIC_FALLBACK_BETA);
	}

	return { url: ANTHROPIC_URL, betas, body };
}

/**
 * Body for resuming a turn that Anthropic paused (`stop_reason: "pause_turn"`):
 * the same request with the paused assistant content appended, and nothing else.
 */
export function buildAnthropicContinuation(
	body:             Record<string, unknown>,
	assistantContent: unknown[],
): Record<string, unknown> {
	const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
	return {
		...body,
		messages: [...messages, { role: "assistant", content: assistantContent }],
	};
}

/**
 * Body for answering the tool calls of an Anthropic reply (`stop_reason: "tool_use"`):
 * the same request with the assistant content — thinking blocks included, unchanged —
 * and one result per call appended.
 */
export function buildAnthropicToolResults(
	body:             Record<string, unknown>,
	assistantContent: unknown[],
	results:          ToolResult[],
): Record<string, unknown> {
	const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
	return {
		...body,
		messages: [
			...messages,
			{ role: "assistant", content: assistantContent },
			{
				role:    "user",
				content: results.map(result => ({
					type:        "tool_result",
					tool_use_id: result.id,
					content:     result.content,
					...(result.isError ? { is_error: true } : {}),
				})),
			},
		],
	};
}
