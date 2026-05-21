// ─── Chat / Messages ──────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
	role:    MessageRole;
	content: string;
}

// ─── History ──────────────────────────────────────────────────────────────────

export interface ChatSession {
	id:        string;
	title:     string;
	projectId: string | null;
	messages:  ChatMessage[];
	createdAt: number;
	updatedAt: number;
	preview?:  string;
	model?:    string;
}

/** Lightweight entry in the history index (without messages) */
export interface SessionMeta {
	id:        string;
	title:     string;
	projectId: string | null;
	createdAt: number;
	updatedAt: number;
	preview?:  string;
	model?:    string;
}

export interface HistoryIndex {
	sessions: SessionMeta[];
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export interface Project {
	id:           string;
	name:         string;
	color:        string;
	systemPrompt: string;
	createdAt:    number;
	updatedAt:    number;
}

export interface ProjectsFile {
	projects: Project[];
}

// ─── RAG ──────────────────────────────────────────────────────────────────────

export interface RAGEntry {
	path:      string;
	basename:  string;
	extension?: string;
	folder?:    string;
	mtime?:     number;
	chunk:     string;
	tokens:    string[];
	embedding: number[] | null;

	// Cache — not persisted to JSON (underscore prefix)
	_tf?:     Record<string, number>;
	_embNorm?: number | null;
}

export interface RAGIndex {
	_version: number;
	entries:  RAGEntry[];
	hashes:   Record<string, string>;
}

export interface RAGSearchResult {
	path:     string;
	basename: string;
	chunk:    string;
	score:    number;
}

// ─── API ──────────────────────────────────────────────────────────────────────

export interface UsageStats {
	inputTokens?:     number;
	outputTokens?:    number;
	reasoningTokens?: number;
}

export interface APICallOptions {
	apiKey:     string;
	model:      string;
	messages:   ChatMessage[];
	mode:       string;
	webSearch?: boolean;
	onChunk?:   ((delta: string) => void) | null;
	signal?:    AbortSignal | null;
}
