import type { Provider } from "./settings";

// ─── Model sets ───────────────────────────────────────────────────────────────

/** Models that support built-in web search */
export const WEB_SEARCH_CAPABLE = new Set<string>([
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
	"gpt-5-search-api",
]);

/** GPT-5 family models (reasoning) — require max_completion_tokens + reasoning_effort */
export const GPT5_MODELS = new Set<string>([
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
]);

/** GPT-5 variant with built-in web search (non-reasoning) */
export const GPT5_SEARCH_API = "gpt-5-search-api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function isGPT5(model: string): boolean {
	return GPT5_MODELS.has(model);
}

export function isGPT5Search(model: string): boolean {
	return model === GPT5_SEARCH_API;
}

/**
 * Detects the AI provider from a model id.
 * claude-* -> Anthropic, GPT/o-series/text-davinci -> OpenAI, everything else -> Ollama.
 */
export function detectProvider(model: string): Provider {
	const lower = model.trim().toLowerCase();

	if (lower.startsWith("claude")) return "anthropic";

	if (
		lower.startsWith("gpt-") ||
		lower.startsWith("o1") ||
		lower.startsWith("o3") ||
		lower.startsWith("o4") ||
		lower.startsWith("chatgpt-") ||
		lower.startsWith("text-davinci")
	) return "openai";

	return "ollama";
}

/** Maps internal thinking modes → reasoning_effort for GPT-5 */
export function mapEffortForGPT5(mode: string): string {
	switch (mode) {
		case "fast":   return "minimal";
		case "normal": return "medium";
		case "think":  return "high";
		default:       return "medium";
	}
}

// ─── Thinking modes ───────────────────────────────────────────────────────────

import { t } from "./i18n";

export interface ThinkingModeConfig {
	readonly label:  string;
	readonly desc:   string;
	readonly tokens: number;
	readonly effort: string;
}

/** Lazy getters — label and desc resolved from the active language at runtime */
export const THINKING_MODES: Record<string, ThinkingModeConfig> = {
	fast: {
		get label()  { return t("chat_mode_fast"); },
		get desc()   { return t("chat_mode_fast_desc"); },
		tokens: 4096,
		effort: "low",
	},
	normal: {
		get label()  { return t("chat_mode_normal"); },
		get desc()   { return t("chat_mode_normal_desc"); },
		tokens: 8192,
		effort: "medium",
	},
	think: {
		get label()  { return t("chat_mode_think"); },
		get desc()   { return t("chat_mode_think_desc"); },
		tokens: 16000,
		effort: "high",
	},
};

// ─── Custom error ─────────────────────────────────────────────────────────────

interface ModelAccessErrorOptions {
	model?:  string;
	status?: number;
	code?:   string;
}

/** Thrown when the model is unavailable for the account (403/404) */
export class ModelAccessError extends Error {
	readonly model?:  string;
	readonly status?: number;
	readonly code?:   string;

	constructor(message: string, { model, status, code }: ModelAccessErrorOptions = {}) {
		super(message);
		this.name   = "ModelAccessError";
		this.model  = model;
		this.status = status;
		this.code   = code;
	}
}
