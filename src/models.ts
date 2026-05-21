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

/** Maps internal thinking modes → reasoning_effort for GPT-5 */
export function mapEffortForGPT5(mode: string): string {
	switch (mode) {
		case "fast":   return "minimal";
		case "normal": return "medium";
		case "think":  return "high";
		default:       return "medium";
	}
}

// ─── Pricing (USD per 1M tokens) ──────────────────────────────────────────────

interface ModelPrice {
	input:  number;
	output: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
	// OpenAI
	"gpt-5":              { input: 1.25,  output: 10.00 },
	"gpt-5-mini":         { input: 0.25,  output: 2.00  },
	"gpt-5-nano":         { input: 0.05,  output: 0.40  },
	"gpt-5-search-api":   { input: 1.25,  output: 10.00 },
	"gpt-4o":             { input: 2.50,  output: 10.00 },
	"gpt-4o-mini":        { input: 0.15,  output: 0.60  },
	"gpt-4-turbo":        { input: 10.00, output: 30.00 },
	// Anthropic
	"claude-opus-4-5":    { input: 15.00, output: 75.00 },
	"claude-sonnet-4-5":  { input: 3.00,  output: 15.00 },
	"claude-haiku-4-5":   { input: 0.80,  output: 4.00  },
};

/**
 * Estimates the request cost in USD.
 * @returns formatted string (e.g. "$0.0042") or null when no pricing is available.
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): string | null {
	const p = MODEL_PRICING[model];
	if (!p) return null;
	const cost = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
	if (cost < 0.0001) return "<$0.0001";
	if (cost < 0.01)   return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(3)}`;
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
