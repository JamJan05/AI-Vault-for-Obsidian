// ─── Chat / Messages ──────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";

/** A note that was put into the prompt for an answer. Never sent to a provider. */
export interface MessageSource {
	label:   string;
	/** Vault-relative path of the note. */
	path:    string;
	/** Beginning of the fragment that was used, to find the passage again. */
	anchor?: string;
	/** Length of the whole fragment, so the passage can be selected. */
	length?: number;
}

export interface ChatMessage {
	role:    MessageRole;
	content: string;
	/** Kept with an assistant message in the history; stripped from every request. */
	sources?: MessageSource[];
	/** Notes the model changed while answering. Kept in the history; never sent. */
	changes?: MessageSource[];
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

// ─── Projects ─────────────────────────────────────────────────────────────────

export interface Project {
	id:           string;
	name:         string;
	color:        string;
	systemPrompt: string;
	createdAt:    number;
	updatedAt:    number;
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
