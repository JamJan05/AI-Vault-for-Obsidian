/**
 * Provider response contracts and Base URL shaping.
 *
 * Everything here treats provider output as untrusted input and is deliberately
 * free of Obsidian and Node imports, so the validation can be unit tested exactly
 * as the runtime uses it.
 */

import type { LocalApiType } from "../settings";
import type { ToolCall } from "../tools/types";

// ─── Response shapes (validated with type guards) ───────────────────────────────

interface OpenAIModelsResponse {
	data?: Array<{ id?: unknown }>;
}

interface OllamaModelsResponse {
	models?: Array<{ name?: unknown }>;
}

interface OpenAIChatResponse {
	choices?: Array<{ message?: { content?: unknown } }>;
}

interface OllamaChatResponse {
	message?: { content?: unknown };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

// ─── URL shaping ────────────────────────────────────────────────────────────────

/**
 * Normalizes a local Base URL.
 * - Strips trailing slashes.
 * - For "openai-compatible": ensures the URL ends with /v1.
 * - For "ollama": leaves the host as-is (endpoints are /api/tags, /api/chat).
 *
 * This only shapes the string. Whether the result may be contacted at all is
 * decided by `assessLocalBaseUrl` in `src/security/urlPolicy.ts`.
 */
export function normalizeLocalBaseUrl(baseUrl: string, localApiType: LocalApiType): string {
	const url = (baseUrl ?? "").trim().replace(/\/+$/, "");
	if (localApiType === "openai-compatible" && url.length > 0 && !/\/v1$/i.test(url)) {
		return `${url}/v1`;
	}
	return url;
}

// ─── Model list parsing ─────────────────────────────────────────────────────────

export function parseLocalModelList(data: unknown, type: LocalApiType): string[] {
	if (type === "openai-compatible") {
		if (!isRecord(data) || !Array.isArray(data.data)) {
			throw new Error("Invalid OpenAI-compatible response. Expected data[].id.");
		}
		const response = data as OpenAIModelsResponse;
		return response.data
			?.map(model => model.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0) ?? [];
	}

	if (!isRecord(data) || !Array.isArray(data.models)) {
		throw new Error("Invalid Ollama response. Expected models[].name.");
	}
	const response = data as OllamaModelsResponse;
	return response.models
		?.map(model => model.name)
		.filter((name): name is string => typeof name === "string" && name.length > 0) ?? [];
}

// ─── Chat content extraction ────────────────────────────────────────────────────

export function extractOpenAIContent(data: unknown): string {
	if (!isRecord(data) || !Array.isArray(data.choices)) {
		throw new Error("Invalid OpenAI-compatible response. Expected choices[0].message.content.");
	}
	const response = data as OpenAIChatResponse;
	const content  = response.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : "";
}

export function extractOllamaContent(data: unknown): string {
	if (!isRecord(data) || !isRecord(data.message)) {
		throw new Error("Invalid Ollama response. Expected message.content.");
	}
	const response = data as OllamaChatResponse;
	const content  = response.message?.content;
	return typeof content === "string" ? content.trim() : "";
}

/** Chat Completions: `choices[0].message.content`, or null when absent/mistyped. */
export function extractOpenAIChatText(event: Record<string, unknown>): string | null {
	if (!isUnknownArray(event.choices)) return null;
	const first = event.choices[0];
	if (!isRecord(first) || !isRecord(first.message)) return null;
	return typeof first.message.content === "string" ? first.message.content : null;
}

/** Responses API: concatenated `output[].content[].text` for `output_text` parts. */
export function extractOpenAIResponsesText(response: Record<string, unknown>): string | null {
	if (!isUnknownArray(response.output)) return null;
	const fragments: string[] = [];
	for (const item of response.output) {
		if (!isRecord(item) || !isUnknownArray(item.content)) continue;
		for (const content of item.content) {
			if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
				fragments.push(content.text);
			}
		}
	}
	return fragments.join("") || null;
}

export interface WebCitation {
	url:   string;
	title: string;
}

/** Only http(s) links are ever turned into a clickable source. */
function isWebUrl(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Responses API: `url_citation` annotations on `output_text` parts, de-duplicated
 * by URL in order of first appearance. Anything that is not a plain web link is dropped.
 */
export function extractOpenAIResponsesCitations(response: Record<string, unknown>): WebCitation[] {
	if (!isUnknownArray(response.output)) return [];
	const seen = new Map<string, WebCitation>();

	for (const item of response.output) {
		if (!isRecord(item) || !isUnknownArray(item.content)) continue;
		for (const content of item.content) {
			if (!isRecord(content) || content.type !== "output_text") continue;
			if (!isUnknownArray(content.annotations)) continue;

			for (const annotation of content.annotations) {
				if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
				const url = typeof annotation.url === "string" ? annotation.url.trim() : "";
				if (!url || !isWebUrl(url) || seen.has(url)) continue;
				const title = typeof annotation.title === "string" ? annotation.title.trim() : "";
				seen.set(url, { url, title });
			}
		}
	}
	return [...seen.values()];
}

/**
 * Renders the sources that the answer does not already link to as a Markdown list.
 * Titles come from the open web, so everything that could break out of the link
 * text is stripped. Returns an empty string when there is nothing to add.
 */
export function formatCitations(text: string, citations: WebCitation[], heading: string): string {
	const missing = citations.filter(c => !text.includes(c.url));
	if (!missing.length) return "";

	const lines = missing.map(c => {
		const title = c.title.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
		// encodeURIComponent leaves parentheses alone, and they end a Markdown link.
		const url   = c.url.replace(/[()<>\s]/g, ch =>
			"%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
		return `- [${title || url}](${url})`;
	});
	return `\n\n**${heading}**\n${lines.join("\n")}`;
}

/** Anthropic Messages: `stop_reason`, or null when absent/mistyped. */
export function readAnthropicStopReason(response: Record<string, unknown>): string | null {
	return typeof response.stop_reason === "string" ? response.stop_reason : null;
}

/** Anthropic Messages: the raw `content` blocks, needed to resume a paused turn. */
export function readAnthropicContent(response: Record<string, unknown>): unknown[] {
	return isUnknownArray(response.content) ? response.content : [];
}

/** The model that actually produced the response, or null when absent/mistyped. */
export function readServedModel(response: Record<string, unknown>): string | null {
	return typeof response.model === "string" && response.model ? response.model : null;
}

/** Anthropic Messages: concatenated `content[].text` for `text` blocks. */
export function extractAnthropicText(event: Record<string, unknown>): string | null {
	if (!isUnknownArray(event.content)) return null;
	const fragments: string[] = [];
	for (const block of event.content) {
		if (
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string"
		) fragments.push(block.text);
	}
	return fragments.join("") || null;
}

// ─── Tool calls ─────────────────────────────────────────────────────────────────

/**
 * Anthropic Messages: the `tool_use` blocks the plugin has to answer. Server
 * tools (`server_tool_use`, such as web search) are run by Anthropic and skipped.
 */
export function readAnthropicToolCalls(response: Record<string, unknown>): ToolCall[] {
	if (!isUnknownArray(response.content)) return [];
	const calls: ToolCall[] = [];
	for (const block of response.content) {
		if (!isRecord(block) || block.type !== "tool_use") continue;
		if (typeof block.id !== "string" || !block.id || typeof block.name !== "string") continue;
		calls.push({ id: block.id, name: block.name, input: block.input });
	}
	return calls;
}

/** Responses API: the raw `output` items, needed to answer function calls. */
export function readOpenAIOutput(response: Record<string, unknown>): unknown[] {
	return isUnknownArray(response.output) ? response.output : [];
}

/**
 * Responses API: the `function_call` items. Arguments arrive as a JSON string;
 * when it does not parse, `input` is undefined and the tool reports the error.
 */
export function readOpenAIToolCalls(response: Record<string, unknown>): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const item of readOpenAIOutput(response)) {
		if (!isRecord(item) || item.type !== "function_call") continue;
		if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string") continue;

		let input: unknown;
		try {
			input = typeof item.arguments === "string" ? JSON.parse(item.arguments) : undefined;
		} catch {
			input = undefined;
		}
		calls.push({ id: item.call_id, name: item.name, input });
	}
	return calls;
}
