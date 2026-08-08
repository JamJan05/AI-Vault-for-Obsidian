import { requestUrl } from "obsidian";

import {
	extractOllamaContent,
	extractOpenAIContent,
	normalizeLocalBaseUrl,
	parseLocalModelList,
} from "./contracts";
import { assessLocalBaseUrl } from "../security/urlPolicy";
import { sanitizeErrorDetail, safeErrorMessage } from "../security/redact";
import type { ChatMessage } from "../types";
import type { PluginSettings } from "../settings";

// Re-exported so existing importers (SettingsTab, tests) keep one entry point.
export { normalizeLocalBaseUrl, parseLocalModelList } from "./contracts";

export interface LocalCallOptions {
	temperature?: number;
	maxTokens?:   number;
}

function isAuthenticationFailure(status: number): boolean {
	return status === 401 || status === 403;
}

/**
 * Fixed, secret-free message for a non-2xx Local API response.
 *
 * The response body comes from an endpoint the user configured and that this
 * plugin does not control, so only a sanitized, length-capped fragment is ever
 * attached — never the raw body.
 */
function localHttpError(status: number, body: unknown, fallbackHint: string): Error {
	const detail = sanitizeErrorDetail(body);
	return new Error(`Local API error ${status}: ${detail || fallbackHint}`);
}

export function buildLocalApiHeaders(settings: PluginSettings, includeJsonContentType = false): Record<string, string> {
	const headers: Record<string, string> = {};
	if (includeJsonContentType) headers["Content-Type"] = "application/json";

	const localApiKey = settings.localApiKey?.trim();
	if (localApiKey) headers["Authorization"] = `Bearer ${localApiKey}`;

	return headers;
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
		throw new Error(safeErrorMessage(
			"Could not connect to Local API. Check that LM Studio/Ollama is running and the Base URL is correct.",
			err,
		));
	}
}

/**
 * Resolves the Base URL and refuses anything the URL policy rejects.
 *
 * A remote plaintext endpoint is NOT blocked here — the user may legitimately run
 * a server on their LAN — but the settings UI warns before the value is saved and
 * PRIVACY.md documents the consequence.
 */
function resolveBaseUrl(settings: PluginSettings): string {
	const base = normalizeLocalBaseUrl(settings.localBaseUrl, settings.localApiType);
	if (!base) throw new Error("Local API Base URL is empty.");

	const assessment = assessLocalBaseUrl(base);
	if (!assessment.usable) {
		throw new Error(
			assessment.reason === "forbidden-scheme"
				? `Local API Base URL uses an unsupported scheme (${assessment.protocol ?? "unknown"}). Use http:// or https://.`
				: "Local API Base URL is not a valid http:// or https:// address.",
		);
	}

	return base;
}

// ─── Fetch available models ─────────────────────────────────────────────────────

export async function fetchLocalModels(settings: PluginSettings): Promise<string[]> {
	const base = resolveBaseUrl(settings);
	const url  = settings.localApiType === "ollama" ? `${base}/api/tags` : `${base}/models`;

	const response = await requestLocal({
		url,
		method:  "GET",
		headers: buildLocalApiHeaders(settings),
	});
	if (isAuthenticationFailure(response.status)) {
		throw new Error("Authentication failed. Check your Local API key and Base URL.");
	}
	if (response.status < 200 || response.status >= 300) {
		throw localHttpError(response.status, response.text, "Check that the Base URL and API type are correct.");
	}

	const models = parseLocalModelList(response.json, settings.localApiType);
	if (models.length === 0) {
		throw new Error("No models found. Load a model in LM Studio or run ollama pull <model>.");
	}
	return models;
}

// ─── Send a chat request ────────────────────────────────────────────────────────

async function postLocal(settings: PluginSettings, url: string, body: Record<string, unknown>): Promise<unknown> {
	const response = await requestLocal({
		url,
		method:  "POST",
		headers: buildLocalApiHeaders(settings, true),
		body:    JSON.stringify(body),
	});

	if (isAuthenticationFailure(response.status)) {
		throw new Error("Authentication failed. Check your Local API key and Base URL.");
	}
	if (response.status < 200 || response.status >= 300) {
		throw localHttpError(response.status, response.text, "The Local API rejected the request.");
	}

	return response.json;
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

	const base            = resolveBaseUrl(settings);
	const payloadMessages = messages.map(m => ({ role: m.role, content: m.content }));

	if (settings.localApiType === "ollama") {
		const body: Record<string, unknown> = {
			model:    settings.localModel,
			messages: payloadMessages,
			stream:   false,
		};
		const data    = await postLocal(settings, `${base}/api/chat`, body);
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

	const data    = await postLocal(settings, `${base}/chat/completions`, body);
	const content = extractOpenAIContent(data);
	if (!content) throw new Error("Invalid OpenAI-compatible response. Expected choices[0].message.content.");
	return content;
}
