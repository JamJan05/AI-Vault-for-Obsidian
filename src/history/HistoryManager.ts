import { DIR_HISTORY, FILE_HISTORY_INDEX } from "../constants";
import { t } from "../i18n";
import type { ExternalStorage } from "../storage/ExternalStorage";
import type { ChatMessage, ChatSession, SessionMeta } from "../types";

interface PluginWithStorage {
	externalStorage: ExternalStorage;
}

/**
 * Manages chat history.
 * Architecture: a lightweight index (SessionMeta[]) kept in memory plus lazy
 * loading of messages from per-session files (session-{id}.json) — loaded
 * only on demand. Capped at 100 sessions — oldest are evicted.
 */
export class HistoryManager {
	/** Lightweight index — metadata without message bodies */
	sessions: SessionMeta[] = [];

	private readonly storage:        ExternalStorage;
	private readonly messagesCache:  Record<string, ChatMessage[]> = {};

	constructor(private readonly plugin: PluginWithStorage) {
		this.storage = plugin.externalStorage;
	}

	// ── Paths ──────────────────────────────────────────────────────────────────

	get historyDir(): string { return this.storage.resolve(DIR_HISTORY); }
	get indexPath():  string { return this.storage.resolve(FILE_HISTORY_INDEX); }

	private sessionPath(id: string): string {
		// Validate id — only alphanumerics, underscores and dashes (id = Date.now() in practice)
		const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
		return `${this.historyDir}/session-${safe}.json`;
	}

	// ── Loading ────────────────────────────────────────────────────────────────

	async load(): Promise<void> {
		await this.storage.ensureDir(this.historyDir);
		const index = await this.storage.readJson<SessionMeta[] | null>(this.indexPath, null);
		if (Array.isArray(index) && index.length) {
			this.sessions = index;
		}
	}

	// ── Saving ─────────────────────────────────────────────────────────────────

	private async saveIndex(): Promise<void> {
		await this.storage.writeJson(this.indexPath, this.sessions);
	}

	async save(): Promise<void> {
		await this.saveIndex();
	}

	// ── Messages ───────────────────────────────────────────────────────────────

	async getMessages(sessionId: string): Promise<ChatMessage[]> {
		if (this.messagesCache[sessionId]) return this.messagesCache[sessionId];

		const path = this.sessionPath(sessionId);

		// If the file does not exist, the session is genuinely empty — cache and return []
		if (!(await this.storage.exists(path))) {
			this.messagesCache[sessionId] = [];
			return this.messagesCache[sessionId];
		}

		// File exists — read it. readJson returns fallback on parse/IO failure,
		// but we MUST NOT cache that fallback: a transient failure would otherwise
		// permanently mask the real history and the next save would overwrite the
		// file with only the latest messages.
		const messages = await this.storage.readJson<ChatMessage[] | null>(path, null);
		if (!Array.isArray(messages)) {
			console.warn("[AI-Vault] getMessages: read failed, not caching", path);
			return [];
		}

		this.messagesCache[sessionId] = messages;
		return messages;
	}

	// ── Session CRUD ───────────────────────────────────────────────────────────

	/** Creates a new empty session (does not persist to disk) */
	newSession(projectId: string | null = null): ChatSession {
		const now = Date.now();
		return {
			id:        now.toString(),
			title:     t("chat_default_title"),
			createdAt: now,
			updatedAt: now,
			messages:  [],
			projectId,
		};
	}

	async saveSession(session: ChatSession): Promise<void> {
		// Persist messages to their own file
		if (session.messages?.length) {
			await this.storage.writeJson(this.sessionPath(session.id), session.messages);
			this.messagesCache[session.id] = session.messages;
		}

		// Update the lightweight index entry
		const meta: SessionMeta = {
			id:           session.id,
			title:        session.title,
			createdAt:    session.createdAt,
			updatedAt:    session.updatedAt,
			projectId:    session.projectId ?? null,
			preview:      session.messages?.find(m => m.role === "user")?.content?.slice(0, 80) ?? "",
			model:        session.model,
		};

		const idx = this.sessions.findIndex(s => s.id === session.id);
		if (idx >= 0) {
			this.sessions[idx] = meta;
		} else {
			this.sessions.unshift(meta);
		}

		// Cap at 100 sessions — drop the oldest
		if (this.sessions.length > 100) {
			const removed = this.sessions.splice(100);
			for (const old of removed) {
				await this.storage.remove(this.sessionPath(old.id));
				delete this.messagesCache[old.id];
			}
		}

		await this.saveIndex();
	}

	async deleteSession(id: string): Promise<void> {
		this.sessions = this.sessions.filter(s => s.id !== id);
		delete this.messagesCache[id];
		await this.storage.remove(this.sessionPath(id));
		await this.saveIndex();
	}

	async getFullSession(id: string): Promise<ChatSession | null> {
		const meta = this.sessions.find(s => s.id === id);
		if (!meta) return null;

		const messages = await this.getMessages(id);
		return { ...meta, messages };
	}
}
