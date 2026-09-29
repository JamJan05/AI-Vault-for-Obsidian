import { t } from "./i18n";
import type { Provider, ThinkingMode } from "./settings";

// ─── Catalogue types ──────────────────────────────────────────────────────────

/** Reasoning depth sent to the provider. `none` means "answer without reasoning". */
export type Effort = "none" | "low" | "medium" | "high";

export type EffortByMode = Readonly<Record<ThinkingMode, Effort>>;

/**
 * How an Anthropic model is asked to think.
 * - `adaptive`: `thinking: { type: "adaptive" }` plus `output_config.effort`.
 * - `budget`:   `thinking: { type: "enabled", budget_tokens }`, only in "think" mode.
 */
export type ClaudeThinkingStyle = "adaptive" | "budget";

export type CloudProvider = Exclude<Provider, "local">;

export interface OpenAIModelProfile {
	/** Null for classic models that take no reasoning parameter. */
	readonly effortByMode: EffortByMode | null;
	readonly webSearch:    boolean;
}

export interface AnthropicModelProfile {
	readonly thinking:        ClaudeThinkingStyle;
	/** Null when the model takes no effort parameter. */
	readonly effortByMode:    EffortByMode | null;
	/** Versioned server-tool type, or null when web search is unavailable. */
	readonly webSearchTool:   string | null;
	/** True when the model accepts the server-side refusal fallback parameter. */
	readonly refusalFallback: boolean;
}

interface CatalogEntryBase {
	readonly id:      string;
	readonly label:   string;
	/** i18n key of the one-line description shown in pickers. */
	readonly descKey: string;
	/** Older model kept for existing users; listed after the current ones. */
	readonly legacy:  boolean;
}

export interface OpenAICatalogEntry extends CatalogEntryBase, OpenAIModelProfile {
	readonly provider: "openai";
}

export interface AnthropicCatalogEntry extends CatalogEntryBase, AnthropicModelProfile {
	readonly provider: "anthropic";
}

export type CatalogEntry = OpenAICatalogEntry | AnthropicCatalogEntry;

// ─── Catalogue ────────────────────────────────────────────────────────────────

export const DEFAULT_OPENAI_MODEL = "gpt-6-sol";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

const WEB_SEARCH_TOOL_CURRENT = "web_search_20260209";
const WEB_SEARCH_TOOL_BASIC   = "web_search_20250305";

const STANDARD_EFFORT: EffortByMode = { fast: "low", normal: "medium", think: "high" };

/**
 * Single source of truth for the models the plugin offers. The chat picker, the
 * settings dropdown, the request builders and the fallback logic all read this.
 */
export const MODEL_CATALOG: readonly CatalogEntry[] = [
	{
		id: "gpt-6-sol", label: "GPT-6 Sol", descKey: "model_desc_gpt6sol",
		provider: "openai", legacy: false, webSearch: true,
		effortByMode: { fast: "none", normal: "medium", think: "high" },
	},
	{
		id: "gpt-6-astra", label: "GPT-6 Astra", descKey: "model_desc_gpt6astra",
		provider: "openai", legacy: false, webSearch: true,
		// Astra does not accept "none".
		effortByMode: STANDARD_EFFORT,
	},
	{
		id: "gpt-6-luna", label: "GPT-6 Luna", descKey: "model_desc_gpt6luna",
		provider: "openai", legacy: false, webSearch: true,
		effortByMode: { fast: "none", normal: "low", think: "high" },
	},
	{
		id: "gpt-5.6-terra", label: "GPT-5.6 Terra", descKey: "model_desc_gpt56terra",
		provider: "openai", legacy: false, webSearch: true,
		effortByMode: { fast: "none", normal: "medium", think: "high" },
	},
	{
		id: "gpt-4o", label: "GPT-4o", descKey: "model_desc_gpt4o",
		provider: "openai", legacy: true, webSearch: true,
		effortByMode: null,
	},
	{
		id: "gpt-4o-mini", label: "GPT-4o Mini", descKey: "model_desc_gpt4omini",
		provider: "openai", legacy: true, webSearch: true,
		effortByMode: null,
	},
	{
		id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", descKey: "model_desc_sonnet",
		provider: "anthropic", legacy: false,
		thinking: "adaptive", effortByMode: STANDARD_EFFORT,
		webSearchTool: WEB_SEARCH_TOOL_CURRENT, refusalFallback: true,
	},
	{
		id: "claude-opus-5-5", label: "Claude Opus 5.5", descKey: "model_desc_opus",
		provider: "anthropic", legacy: false,
		thinking: "adaptive", effortByMode: STANDARD_EFFORT,
		webSearchTool: WEB_SEARCH_TOOL_CURRENT, refusalFallback: true,
	},
	{
		id: "claude-haiku-4-5", label: "Claude Haiku 4.5", descKey: "model_desc_haiku",
		provider: "anthropic", legacy: false,
		thinking: "budget", effortByMode: null,
		webSearchTool: WEB_SEARCH_TOOL_BASIC, refusalFallback: false,
	},
];

/**
 * Models that were offered by earlier plugin versions and are no longer listed,
 * mapped to the catalogue model that replaces them in saved settings.
 */
export const RETIRED_MODELS: Readonly<Record<string, string>> = {
	"gpt-4-turbo":       "gpt-6-sol",
	"gpt-5":             "gpt-6-sol",
	"gpt-5-mini":        "gpt-5.6-terra",
	"gpt-5-nano":        "gpt-6-luna",
	"gpt-5-search-api":  "gpt-6-sol",
	"claude-opus-4-5":   "claude-opus-5-5",
	"claude-sonnet-4-5": "claude-sonnet-5-5",
};

/** Custom Anthropic model ids that are known to accept the refusal fallback parameter. */
const REFUSAL_FALLBACK_EXTRA = new Set<string>(["claude-opus-5", "claude-fable-5-1"]);

// ─── Lookups ──────────────────────────────────────────────────────────────────

function normalizeId(model: string): string {
	return (model ?? "").trim().toLowerCase();
}

export function findCatalogEntry(model: string): CatalogEntry | null {
	const id = normalizeId(model);
	return MODEL_CATALOG.find(entry => entry.id === id) ?? null;
}

export function getCatalogModels(provider: CloudProvider): CatalogEntry[] {
	return MODEL_CATALOG.filter(entry => entry.provider === provider);
}

/** Replacement for a retired model id, or null when the id is not retired. */
export function getReplacementModel(model: string): string | null {
	return RETIRED_MODELS[normalizeId(model)] ?? null;
}

/**
 * Detects the AI provider from a model id.
 * claude-* -> Anthropic, GPT/o-series/text-davinci -> OpenAI, everything else -> Local API.
 */
export function detectProvider(model: string): Provider {
	const lower = normalizeId(model);

	if (lower.startsWith("claude")) return "anthropic";

	if (
		lower.startsWith("gpt-") ||
		lower.startsWith("o1") ||
		lower.startsWith("o3") ||
		lower.startsWith("o4") ||
		lower.startsWith("chatgpt-") ||
		lower.startsWith("text-davinci")
	) return "openai";

	return "local";
}

// ─── Profiles (catalogue entry, or a conservative guess for a custom id) ──────

/** GPT-5 and later, plus the o-series, take a reasoning effort. */
function looksLikeOpenAIReasoningModel(id: string): boolean {
	const gpt = /^gpt-(\d+)/.exec(id);
	if (gpt) return Number(gpt[1]) >= 5;
	return /^o\d/.test(id);
}

export function resolveOpenAIProfile(model: string): OpenAIModelProfile {
	const entry = findCatalogEntry(model);
	if (entry?.provider === "openai") return entry;

	if (looksLikeOpenAIReasoningModel(normalizeId(model))) {
		// "low" rather than "none" for fast mode: not every reasoning model accepts "none".
		return { effortByMode: STANDARD_EFFORT, webSearch: true };
	}
	return { effortByMode: null, webSearch: false };
}

/**
 * Adaptive thinking arrived with the 4.6 generation. The minor version is limited
 * to two digits so a dated snapshot suffix is not mistaken for one.
 */
function looksLikeAdaptiveClaudeModel(id: string): boolean {
	const match = /^claude-(?:opus|sonnet|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = match[2] === undefined ? 0 : Number(match[2]);
	return major > 4 || (major === 4 && minor >= 6);
}

export function resolveAnthropicProfile(model: string): AnthropicModelProfile {
	const entry = findCatalogEntry(model);
	if (entry?.provider === "anthropic") return entry;

	const id = normalizeId(model);
	if (looksLikeAdaptiveClaudeModel(id)) {
		return {
			thinking:        "adaptive",
			effortByMode:    STANDARD_EFFORT,
			webSearchTool:   WEB_SEARCH_TOOL_CURRENT,
			refusalFallback: REFUSAL_FALLBACK_EXTRA.has(id),
		};
	}
	return {
		thinking:        "budget",
		effortByMode:    null,
		webSearchTool:   WEB_SEARCH_TOOL_BASIC,
		refusalFallback: false,
	};
}

export function normalizeThinkingMode(mode: string): ThinkingMode {
	return mode === "fast" || mode === "think" ? mode : "normal";
}

/** True when the model takes a reasoning effort, i.e. is not a classic model. */
export function isOpenAIReasoningModel(model: string): boolean {
	return resolveOpenAIProfile(model).effortByMode !== null;
}

export function supportsWebSearch(provider: Provider, model: string): boolean {
	if (provider === "local") return false;
	if (provider === "anthropic") return resolveAnthropicProfile(model).webSearchTool !== null;
	return resolveOpenAIProfile(model).webSearch;
}

/**
 * Model offered when the selected OpenAI model is unavailable for the account.
 * Never returns the model that just failed.
 */
export function getFallbackModel(failedModel: string): string {
	const failed = normalizeId(failedModel);
	const order  = ["gpt-6-luna", "gpt-4o-mini", "gpt-4o"];
	return order.find(candidate => candidate !== failed) ?? order[0];
}

// ─── Thinking modes ───────────────────────────────────────────────────────────

export interface ThinkingModeConfig {
	readonly label:  string;
	readonly desc:   string;
	readonly tokens: number;
}

/** Lazy getters — label and desc resolved from the active language at runtime */
export const THINKING_MODES: Record<string, ThinkingModeConfig> = {
	fast: {
		get label()  { return t("chat_mode_fast"); },
		get desc()   { return t("chat_mode_fast_desc"); },
		tokens: 4096,
	},
	normal: {
		get label()  { return t("chat_mode_normal"); },
		get desc()   { return t("chat_mode_normal_desc"); },
		tokens: 8192,
	},
	think: {
		get label()  { return t("chat_mode_think"); },
		get desc()   { return t("chat_mode_think_desc"); },
		tokens: 16000,
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
	/** Retrying the same model cannot succeed, so withRetry must not repeat the request. */
	readonly noRetry = true;

	constructor(message: string, { model, status, code }: ModelAccessErrorOptions = {}) {
		super(message);
		this.name   = "ModelAccessError";
		this.model  = model;
		this.status = status;
		this.code   = code;
	}
}
