// ─── View types ───────────────────────────────────────────────────────────────
export const CHAT_VIEW_TYPE     = "gpt-chat-view";
export const HISTORY_VIEW_TYPE  = "gpt-history-view";
export const PROJECTS_VIEW_TYPE = "gpt-projects-view";

// ─── Storage keys (localStorage / data.json) ─────────────────────────────────
export const RAG_INDEX_KEY = "gpt-rag-index-v1";
export const HISTORY_KEY   = "gpt-history-v1";

// ─── RAG tuning ───────────────────────────────────────────────────────────────
export const RAG_TOP_K         = 5;
export const RAG_CHUNK_SIZE    = 1200;
export const RAG_CHUNK_OVERLAP = 150;

// ─── Data files (relative to plugin folder) ──────────────────────────────────
export const FILE_RAG_INDEX     = "rag-index.json";
export const FILE_HISTORY_INDEX = "history-index.json";
export const FILE_PROJECTS      = "projects.json";
export const FILE_API_KEYS      = "keys.json";
export const DIR_HISTORY        = "history";

// ─── Migration from older versions ────────────────────────────────────────────
export const LEGACY_DIR_NAME = "obsidian-gpt";
