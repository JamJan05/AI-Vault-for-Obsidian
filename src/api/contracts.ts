/**
 * Provider response contracts and Base URL shaping.
 *
 * Everything here treats provider output as untrusted input and is deliberately
 * free of Obsidian and Node imports, so the validation can be unit tested exactly
 * as the runtime uses it.
 */

import type { LocalApiType } from "../settings";

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
