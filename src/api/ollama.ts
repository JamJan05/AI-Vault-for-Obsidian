import { requestUrl } from "obsidian";

import { t } from "../i18n";
import type { ChatMessage } from "../types";
import type { StreamResult } from "./streaming";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OllamaTagsResponse {
	models: Array<{ name: string; modified_at?: string; size?: number }>;
}

interface OllamaStreamChunk {
	choices?: Array<{ delta?: { content?: string } }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOllamaTagsResponse(value: unknown): value is OllamaTagsResponse {
	if (!isRecord(value)) return false;
	const models = value.models;
	return Array.isArray(models) && models.every(model =>
		isRecord(model) && typeof model.name === "string",
	);
}

function abortError(): Error {
	const err = new Error("Aborted by user");
	err.name = "AbortError";
	return err;
}

// ─── Model list ───────────────────────────────────────────────────────────────

/**
 * Fetches model names from a local Ollama instance.
 * Uses Obsidian requestUrl(), not fetch(), because this is a non-streaming request.
 */
export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
	const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;

	const response = await requestUrl({ url, method: "GET", throw: false });
	if (response.status !== 200) {
		throw new Error(`Ollama unreachable (${response.status}). Is the server running?`);
	}

	const data: unknown = response.json;
	if (!isOllamaTagsResponse(data)) return [];

	return data.models.map(model => model.name);
}

// ─── SSE streaming ────────────────────────────────────────────────────────────

/**
 * Calls Ollama's OpenAI-compatible local API through SSE streaming.
 *
 * NOTE: fetch() required for SSE streaming. requestUrl() does not support it.
 * isDesktopOnly: true in manifest.json covers this requirement.
 */
export async function callOllama(
	baseUrl:    string,
	model:      string,
	messages:   ChatMessage[],
	onChunk:    ((fullText: string) => void) | null = null,
	signal:     AbortSignal | null = null,
	maxTokens?: number,
): Promise<StreamResult> {
	const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
	const body: Record<string, unknown> = {
		model,
		messages: messages.map(m => ({ role: m.role, content: m.content })),
		stream: true,
	};
	if (typeof maxTokens === "number") body.max_tokens = maxTokens;

	// NOTE: fetch() required for SSE streaming. requestUrl() does not support it.
	// isDesktopOnly: true in manifest.json covers this requirement.
	const response = await fetch(endpoint, {
		method:  "POST",
		headers: { "Content-Type": "application/json" },
		body:    JSON.stringify(body),
		signal:  signal ?? undefined,
	});

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`Ollama error ${response.status}: ${errText}`);
	}
	if (!response.body) throw new Error("Ollama response did not include a stream.");

	const reader  = response.body.getReader();
	const decoder = new TextDecoder();
	let fullText = "";
	let buffer   = "";
	let finished = false;

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
				if (data === "[DONE]") {
					finished = true;
					break;
				}

				let event: OllamaStreamChunk;
				try {
					event = JSON.parse(data) as OllamaStreamChunk;
				} catch {
					continue;
				}

				const delta = event.choices?.[0]?.delta?.content ?? "";
				if (delta) {
					fullText += delta;
					onChunk?.(fullText);
				}
			}
		}
	} finally {
		if (!finished) {
			try { await reader.cancel(); } catch { /* ignore */ }
		}
	}

	if (!fullText.trim()) throw new Error(t("err_empty_response"));
	return { text: fullText.trim(), usage: null };
}
