import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL } from "./models";

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
	/**
	 * Names of the secrets in Obsidian's SecretStorage that hold the keys above.
	 * When these are in use the key values themselves are never written to disk
	 * by the plugin — see src/security/keyStore.ts.
	 */
	openaiSecretName:       string;
	claudeSecretName:       string;
	localSecretName:        string;

	// Models
	provider:               Provider;
	model:                  string;
	claudeModel:            string;
	localApiType:           LocalApiType;
	localBaseUrl:           string;
	localModel:             string;
	localModelsCache:       string[];
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
	/**
	 * Semantic search. When on, note text and questions are sent to OpenAI to be
	 * turned into embeddings. Off by default — see src/rag/embeddings.ts.
	 */
	ragEmbeddingsEnabled:   boolean;
	ragSearchMode:          RAGSearchMode;
	/** One ignore pattern per line — see src/rag/ignorePaths.ts for the semantics. */
	ragExcludedPaths:       string;

	// Note tools
	/**
	 * Master switch for the note tools. While it is off the chat view offers no
	 * way to let a model read or change notes — see src/tools/noteTools.ts.
	 */
	noteEditingEnabled:     boolean;
	/** Write the model's changes without showing them for approval first. */
	noteEditingAutoApply:   boolean;

	// External storage
	externalStorageEnabled: boolean;
	externalStoragePath:    string;

	// Context window
	maxContextMessages:     number;

	// UI
	language:               Language;

	// Internal flags
	_externalMigrationDone?: boolean;
	/** Set once the upgrade notice about opt-in semantic search has been shown. */
	_embeddingsNoticeShown?: boolean;
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
	model:                   DEFAULT_OPENAI_MODEL,
	claudeModel:             DEFAULT_CLAUDE_MODEL,
	localApiType:            "openai-compatible",
	localBaseUrl:            DEFAULT_LOCAL_OPENAI_URL,
	localModel:              "",
	localModelsCache:        [],
	thinkingMode:            "normal",
	maxTokensFast:           4096,
	maxTokensNormal:         8192,
	maxTokensThink:          16000,
	systemPrompt:            DEFAULT_SYSTEM_PROMPTS.en,
	ragEnabled:              true,
	ragAutoIndex:            true,
	ragEmbeddingsEnabled:    false,
	ragSearchMode:           "hybrid",
	ragExcludedPaths:        "",
	noteEditingEnabled:      false,
	noteEditingAutoApply:    false,
	externalStorageEnabled:  true,
	externalStoragePath:     "",
	apiKeysInSync:           false,
	openaiSecretName:        "",
	claudeSecretName:        "",
	localSecretName:         "",
	maxContextMessages:      0,
	language:                "en",
};
