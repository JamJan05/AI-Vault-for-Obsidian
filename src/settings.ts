// ─── Types ────────────────────────────────────────────────────────────────────

export type ThinkingMode = "fast" | "normal" | "think";
export type Provider     = "openai" | "anthropic" | "local";
export type LocalApiType = "openai-compatible" | "ollama";
export type Language     = "en" | "pl";

export type RAGSearchMode = "hybrid" | "semantic" | "exact" | "recent";

// Default Base URLs per local API type
export const DEFAULT_LOCAL_OPENAI_URL = "http://localhost:1234/v1";
export const DEFAULT_LOCAL_OLLAMA_URL = "http://localhost:11434";

export interface PluginSettings {
	// API Keys
	apiKey:                 string;
	claudeApiKey:           string;
	localApiKey:            string;
	apiKeysInSync:          boolean;

	// Models
	provider:               Provider;
	model:                  string;
	claudeModel:            string;
	localApiType:           LocalApiType;
	localBaseUrl:           string;
	localModel:             string;
	localModelsCache:       string[];
	autoDetectProvider:     boolean;
	thinkingMode:           ThinkingMode;

	// Max tokens per thinking mode
	maxTokensFast:          number;
	maxTokensNormal:        number;
	maxTokensThink:         number;

	// Prompts
	systemPrompt:           string;

	// RAG
	ragEnabled:             boolean;
	ragAutoIndex:           boolean;
	ragSearchMode:          RAGSearchMode;
	/** One ignore pattern per line — see src/rag/ignorePaths.ts for the semantics. */
	ragExcludedPaths:       string;

	// External storage
	externalStorageEnabled: boolean;
	externalStoragePath:    string;

	// Context window
	maxContextMessages:     number;

	// UI
	language:               Language;

	// Internal flags
	_externalMigrationDone?: boolean;
}

// ─── Default system prompts ───────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPTS: Record<Language, string> = {
	en: "You are a helpful assistant integrated with Obsidian. Reply in the user's language. Be concise, specific and helpful.",
	pl: "Jesteś pomocnym asystentem zintegrowanym z Obsidian. Odpowiadaj w języku użytkownika. Bądź zwięzły, konkretny i pomocny.",
};

// ─── Default settings ─────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: PluginSettings = {
	apiKey:                  "",
	claudeApiKey:            "",
	localApiKey:             "",
	provider:                "openai",
	model:                   "gpt-4o",
	claudeModel:             "claude-sonnet-4-5",
	localApiType:            "openai-compatible",
	localBaseUrl:            DEFAULT_LOCAL_OPENAI_URL,
	localModel:              "",
	localModelsCache:        [],
	autoDetectProvider:      true,
	thinkingMode:            "normal",
	maxTokensFast:           4096,
	maxTokensNormal:         8192,
	maxTokensThink:          16000,
	systemPrompt:            DEFAULT_SYSTEM_PROMPTS.en,
	ragEnabled:              true,
	ragAutoIndex:            true,
	ragSearchMode:           "hybrid",
	ragExcludedPaths:        "",
	externalStorageEnabled:  true,
	externalStoragePath:     "",
	apiKeysInSync:           false,
	maxContextMessages:      0,
	language:                "en",
};
