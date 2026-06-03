import { requestUrl } from "obsidian";

import type { ChatMessage } from "../types";
import type { LocalApiType, PluginSettings } from "../settings";

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

export interface LocalCallOptions {
	temperature?: number;
	maxTokens?:   number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function requestLocal(options: {
	url: string;
	method: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
}) {
	try {
		return await requestUrl({ ...options, throw: false });
	} catch (err: unknown) {
		throw new Error(
			`Could not connect to Local API. Check that LM Studio/Ollama is running and the Base URL is correct. ${errorMessage(err)}`,
		);
	}
}

// ─── URL normalization ──────────────────────────────────────────────────────────

/**
 * Normalizes a local Base URL.
 * - Strips trailing slashes.
 * - For "openai-compatible": ensures the URL ends with /v1.
 * - For "ollama": leaves the host as-is (endpoints are /api/tags, /api/chat).
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

// ─── Fetch available models ─────────────────────────────────────────────────────

export async function fetchLocalModels(settings: PluginSettings): Promise<string[]> {
	const base = normalizeLocalBaseUrl(settings.localBaseUrl, settings.localApiType);
	if (!base) throw new Error("Local API Base URL is empty.");

	const url  = settings.localApiType === "ollama" ? `${base}/api/tags` : `${base}/models`;

	const response = await requestLocal({ url, method: "GET" });
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Local API error ${response.status}: ${response.text || "Check that the Base URL and API type are correct."}`);
	}

	const models = parseLocalModelList(response.json, settings.localApiType);
	if (models.length === 0) {
		throw new Error("No models found. Load a model in LM Studio or run ollama pull <model>.");
	}
	return models;
}

// ─── Send a chat request ────────────────────────────────────────────────────────

async function postLocal(url: string, body: Record<string, unknown>): Promise<unknown> {
	const response = await requestLocal({
		url,
		method:  "POST",
		headers: { "Content-Type": "application/json" },
		body:    JSON.stringify(body),
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Local API error ${response.status}: ${response.text}`);
	}

	return response.json;
}

function extractOpenAIContent(data: unknown): string {
	if (!isRecord(data) || !Array.isArray(data.choices)) {
		throw new Error("Invalid OpenAI-compatible response. Expected choices[0].message.content.");
	}
	const response = data as OpenAIChatResponse;
	const content  = response.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : "";
}

function extractOllamaContent(data: unknown): string {
	if (!isRecord(data) || !isRecord(data.message)) {
		throw new Error("Invalid Ollama response. Expected message.content.");
	}
	const response = data as OllamaChatResponse;
	const content  = response.message?.content;
	return typeof content === "string" ? content.trim() : "";
}

/**
 * Calls a local OpenAI-compatible or Ollama server (non-streaming).
 * Uses Obsidian requestUrl(), not fetch(), per Community Plugin guidelines.
 */
export async function callLocalApi(
	settings: PluginSettings,
	messages: ChatMessage[],
	options:  LocalCallOptions = {},
): Promise<string> {
	if (!settings.localModel?.trim()) {
		throw new Error("No local model selected. Start your local server, refresh models, and select a model.");
	}

	const base            = normalizeLocalBaseUrl(settings.localBaseUrl, settings.localApiType);
	if (!base) throw new Error("Local API Base URL is empty.");

	const payloadMessages = messages.map(m => ({ role: m.role, content: m.content }));

	if (settings.localApiType === "ollama") {
		const body: Record<string, unknown> = {
			model:    settings.localModel,
			messages: payloadMessages,
			stream:   false,
		};
		const data    = await postLocal(`${base}/api/chat`, body);
		const content = extractOllamaContent(data);
		if (!content) throw new Error("Invalid Ollama response. Expected message.content.");
		return content;
	}

	const body: Record<string, unknown> = {
		model:       settings.localModel,
		messages:    payloadMessages,
		temperature: options.temperature ?? 0.7,
		stream:      false,
	};
	if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;

	const data    = await postLocal(`${base}/chat/completions`, body);
	const content = extractOpenAIContent(data);
	if (!content) throw new Error("Invalid OpenAI-compatible response. Expected choices[0].message.content.");
	return content;
}
