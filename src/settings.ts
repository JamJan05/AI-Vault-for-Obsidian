// ─── Types ────────────────────────────────────────────────────────────────────

export type ThinkingMode = "fast" | "normal" | "think";
export type Provider     = "openai" | "anthropic" | "ollama";
export type Language     = "en" | "pl";

export type RAGSearchMode = "hybrid" | "semantic" | "exact" | "recent";

export interface PluginSettings {
	// API Keys
	apiKey:                 string;
	claudeApiKey:           string;
	apiKeysInSync:          boolean;

	// Models
	provider:               Provider;
	model:                  string;
	claudeModel:            string;
	ollamaBaseUrl:          string;
	ollamaModel:            string;
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
	provider:                "openai",
	model:                   "gpt-4o",
	claudeModel:             "claude-sonnet-4-5",
	ollamaBaseUrl:           "http://localhost:11434",
	ollamaModel:             "llama3.2",
	autoDetectProvider:      true,
	thinkingMode:            "normal",
	maxTokensFast:           4096,
	maxTokensNormal:         8192,
	maxTokensThink:          16000,
	systemPrompt:            DEFAULT_SYSTEM_PROMPTS.en,
	ragEnabled:              true,
	ragAutoIndex:            true,
	ragSearchMode:           "hybrid",
	externalStorageEnabled:  true,
	externalStoragePath:     "",
	apiKeysInSync:           false,
	maxContextMessages:      0,
	language:                "en",
};
