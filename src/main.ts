import { Notice, Plugin, TFile } from "obsidian";

import { t, setLanguage }          from "./i18n";
import { DEFAULT_SETTINGS }        from "./settings";
import { CHAT_VIEW_TYPE, HISTORY_VIEW_TYPE, PROJECTS_VIEW_TYPE, FILE_API_KEYS, RAG_INDEX_KEY, HISTORY_KEY } from "./constants";
import { PluginStorage }           from "./storage/PluginStorage";
import { ExternalStorage }         from "./storage/ExternalStorage";
import { HistoryManager }          from "./history/HistoryManager";
import { ProjectManager }          from "./history/ProjectManager";
import { RAGEngine }               from "./rag/RAGEngine";
import { GPTChatView }             from "./views/ChatView";
import { GPTHistoryView }          from "./views/HistoryView";
import { GPTProjectsView }         from "./views/ProjectsView";
import { GPTSettingsTab }          from "./SettingsTab";
import { debounce }                from "./utils";
import type { PluginSettings }     from "./settings";
import type { ChatMessage }        from "./types";

export default class GPTPlugin extends Plugin {
	// Obsidian 1.13 declares `settings?: unknown` on Plugin — narrow it here rather
	// than shadowing the base property.
	declare settings: PluginSettings;
	storage!:         PluginStorage;
	externalStorage!: ExternalStorage;
	rag!:             RAGEngine;
	history!:         HistoryManager;
	projects!:        ProjectManager;

	currentSessionId: string | null = null;
	currentSession:   import("./types").ChatSession | null = null;
	activeProjectId:  string | null = null;

	private debouncedUpdateFile!: ReturnType<typeof debounce<[TFile]>>;

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	async onload(): Promise<void> {
		// Storage — vault adapter (mobile + desktop, always available)
		this.storage = new PluginStorage(this);
		await this.loadSettings();
		setLanguage(this.settings.language ?? "en", this);

		// External storage — outside the vault (desktop only, bypasses Obsidian Sync)
		this.externalStorage = new ExternalStorage(this, this.storage);
		const externalActive = await this.externalStorage.init();

		// API keys — from keys.json outside the vault, migrated from old data.json
		await this._loadApiKeys();

		// Auto-migrate history when external storage has just been enabled
		if (externalActive) await this._maybeAutoMigrate();

		// Data managers
		this.rag      = new RAGEngine(this);
		this.history  = new HistoryManager(this);
		this.projects = new ProjectManager(this);
		await this.history.load();
		await this.projects.load();

		// Debounced RAG update — max once per 3s per file
		this.debouncedUpdateFile = debounce((file: TFile) => {
			void this.rag.updateFile(file);
		}, 3000);

		// Startup RAG load + auto-index (without opening chat view)
		if (this.settings.ragEnabled && this.settings.ragAutoIndex) {
			void (async () => {
				const loaded = await this.rag.loadIndex();
				if (!loaded && !this.rag.indexing) await this.rag.buildIndex();
			})();
		}

		// Views
		this.registerView(CHAT_VIEW_TYPE,     leaf => new GPTChatView(leaf, this));
		this.registerView(HISTORY_VIEW_TYPE,  leaf => new GPTHistoryView(leaf, this));
		this.registerView(PROJECTS_VIEW_TYPE, leaf => new GPTProjectsView(leaf, this));

		// Ribbon
		this.addRibbonIcon("message-square", "AI-Vault Chat",     () => void this.activateChatView());
		this.addRibbonIcon("clock",          "AI-Vault History",  () => void this.activateHistoryView());
		this.addRibbonIcon("folder-open",    "AI-Vault Projects", () => void this.activateProjectsView());

		// Commands
		this.addCommand({ id: "open-gpt-chat",     name: t("cmd_open_chat"),    callback: () => void this.activateChatView() });
		this.addCommand({ id: "open-gpt-history",  name: t("cmd_open_history"), callback: () => void this.activateHistoryView() });
		this.addCommand({ id: "open-gpt-projects", name: t("cmd_open_projects"),callback: () => void this.activateProjectsView() });
		this.addCommand({ id: "new-gpt-chat",      name: t("cmd_new_chat"),     callback: () => this.newChat() });

		this.addCommand({
			id: "analyze-selection",
			name: t("cmd_analyze"),
			editorCallback: async editor => {
				const sel = editor.getSelection();
				if (!sel) { new Notice(t("cmd_select_text_first")); return; }
				const view = await this.activateChatView();
				await new Promise(r => window.setTimeout(r, 300));
				void view?.sendMessage(`Analyze:\n\n${sel}`);
			},
		});

		this.addCommand({
			id: "summarize-note",
			name: t("cmd_summarize"),
			editorCallback: async editor => {
				const c = editor.getValue();
				if (!c.trim()) { new Notice(t("cmd_note_empty")); return; }
				const view = await this.activateChatView();
				await new Promise(r => window.setTimeout(r, 300));
				void view?.sendMessage(`Summarize in 5 points:\n\n${c.slice(0, 8000)}`);
			},
		});

		this.addCommand({
			id: "reindex-vault",
			name: t("cmd_reindex"),
			callback: async () => {
				new Notice(t("cmd_indexing"));
				await this.rag.buildIndex();
				const s = this.rag.stats;
				new Notice(t("rag_done", s.files));
			},
		});

		// Vault events — .md and .canvas
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile && (file.extension === "md" || file.extension === "canvas")) {
				this.debouncedUpdateFile(file);
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (file instanceof TFile && (file.extension === "md" || file.extension === "canvas")) {
				this.rag.removeFile(file.path);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, old) => {
			if (file instanceof TFile && (file.extension === "md" || file.extension === "canvas")) {
				this.rag.renameFile(old, file.path, file.basename);
			}
		}));

		// Editor context menu
		this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
			const sel = editor.getSelection();
			if (!sel) return;
			menu.addItem(i => i.setTitle("✦ AI-Vault: Analyze").setIcon("message-square").onClick(async () => {
				const v = await this.activateChatView();
				await new Promise(r => window.setTimeout(r, 300));
				void v?.sendMessage(`Analyze:\n\n${sel}`);
			}));
			menu.addItem(i => i.setTitle("✦ AI-Vault: Summarize").setIcon("list").onClick(async () => {
				const v = await this.activateChatView();
				await new Promise(r => window.setTimeout(r, 300));
				void v?.sendMessage(`Summarize in 3 points:\n\n${sel}`);
			}));
		}));

		this.addSettingTab(new GPTSettingsTab(this.app, this));
	}

	onunload(): void {
		this.debouncedUpdateFile?.cancel();
		this.rag?.saveIndexNow()
			.catch(err => console.warn("[AI-Vault] Failed to save RAG index during unload:", err));
	}

	// ── Sessions ──────────────────────────────────────────────────────────────

	setActiveProject(projectId: string | null): void {
		this.activeProjectId = projectId;
		this.getChatView()?.updateProjectBar();
		this.getProjectsView()?.render();
	}

	newChat(): void {
		this.currentSession   = this.history.newSession(this.activeProjectId);
		this.currentSessionId = this.currentSession.id;
		this.getChatView()?.clearAndNew();
		this.getChatView()?.updateProjectBar();
		this.getHistoryView()?.render();
		this.getProjectsView()?.render();
	}

	async loadSession(id: string): Promise<void> {
		const session = await this.history.getFullSession(id);
		if (!session) return;
		this.currentSession   = session;
		this.currentSessionId = id;
		if (session.projectId) this.activeProjectId = session.projectId;
		const chatView = await this.activateChatView();
		chatView?.loadSession(session);
		chatView?.updateProjectBar();
		this.getHistoryView()?.render();
		this.getProjectsView()?.render();
	}

	async autoSaveSession(messages: ChatMessage[]): Promise<void> {
		if (!this.currentSession) {
			this.currentSession   = this.history.newSession(this.activeProjectId);
			this.currentSessionId = this.currentSession.id;
		}
		if (this.activeProjectId && !this.currentSession.projectId) {
			(this.currentSession as { projectId?: string | null }).projectId = this.activeProjectId;
		}

		const session = this.currentSession as {
			id: string; title: string; projectId: string | null;
			messages: ChatMessage[]; createdAt: number; updatedAt: number;
			model?: string;
		};
		session.messages  = messages;
		session.updatedAt = Date.now();
		session.model     =
			this.settings.provider === "anthropic" ? (this.settings.claudeModel ?? "claude-sonnet-4-5") :
			this.settings.provider === "local"     ? (this.settings.localModel || "") :
			this.settings.model;

		// Auto-title from the first user message
		if (messages.length >= 1 && session.title === "New conversation") {
			const first = messages.find(m => m.role === "user");
			if (first) {
				session.title = first.content.slice(0, 50) + (first.content.length > 50 ? "…" : "");
			}
		}

		await this.history.saveSession(session);
		this.getHistoryView()?.render();
		this.getProjectsView()?.render();
	}

	// ── Views ──────────────────────────────────────────────────────────────────

	getChatView(): GPTChatView | null {
		return this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)
			.map(l => l.view).find((v): v is GPTChatView => v instanceof GPTChatView) ?? null;
	}

	getHistoryView(): GPTHistoryView | null {
		return this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)
			.map(l => l.view).find((v): v is GPTHistoryView => v instanceof GPTHistoryView) ?? null;
	}

	getProjectsView(): GPTProjectsView | null {
		return this.app.workspace.getLeavesOfType(PROJECTS_VIEW_TYPE)
			.map(l => l.view).find((v): v is GPTProjectsView => v instanceof GPTProjectsView) ?? null;
	}

	async activateChatView(): Promise<GPTChatView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		return this.getChatView();
	}

	async activateHistoryView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
		if (!leaf) {
			const projLeaf = workspace.getLeavesOfType(PROJECTS_VIEW_TYPE)[0];
			if (projLeaf) { await projLeaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true }); await workspace.revealLeaf(projLeaf); return; }
			const chatLeaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
			leaf = chatLeaf ? workspace.createLeafBySplit(chatLeaf, "vertical") : (workspace.getLeftLeaf(false) ?? workspace.getLeaf(true));
			await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	async activateProjectsView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(PROJECTS_VIEW_TYPE)[0];
		if (!leaf) {
			const histLeaf = workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
			if (histLeaf) { await histLeaf.setViewState({ type: PROJECTS_VIEW_TYPE, active: true }); await workspace.revealLeaf(histLeaf); return; }
			const chatLeaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
			leaf = chatLeaf ? workspace.createLeafBySplit(chatLeaf, "vertical") : (workspace.getLeftLeaf(false) ?? workspace.getLeaf(true));
			await leaf.setViewState({ type: PROJECTS_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	// ── Settings ───────────────────────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		const d = await this.loadData() as Record<string, unknown> | null;

		// Clean up legacy keys that previously ended up in data.json
		if (d && (d[RAG_INDEX_KEY] || d[HISTORY_KEY])) {
			delete d[RAG_INDEX_KEY];
			delete d[HISTORY_KEY];
			await this.saveData(d);
		}

		this.settings = Object.assign({}, DEFAULT_SETTINGS, d);

		// Migrate the legacy standalone "ollama" provider → unified Local API
		if (d) this._migrateLegacyOllamaSettings(d);
	}

	/** Maps old ollama provider/fields onto the new Local API settings (one-time, non-destructive). */
	private _migrateLegacyOllamaSettings(raw: Record<string, unknown>): void {
		const legacyBaseUrl = raw.ollamaBaseUrl;
		const legacyModel   = raw.ollamaModel;

		if ((raw.provider as string) === "ollama") {
			this.settings.provider     = "local";
			this.settings.localApiType = "ollama";
			if (typeof legacyModel === "string" && legacyModel && !this.settings.localModel) {
				this.settings.localModel = legacyModel;
			}
			if (typeof legacyBaseUrl === "string" && legacyBaseUrl
				&& this.settings.localBaseUrl === DEFAULT_SETTINGS.localBaseUrl) {
				this.settings.localBaseUrl = legacyBaseUrl;
			}
		}
	}

	async saveSettings(): Promise<void> {
		const toSave = { ...this.settings } as unknown as Record<string, unknown>;
		delete toSave[RAG_INDEX_KEY];
		delete toSave[HISTORY_KEY];

		if (this.settings.apiKeysInSync || !this.externalStorage.isEnabled) {
			await this.saveData(toSave);
		} else {
			// Keys go to keys.json outside the vault, the rest to data.json
			const keysPath = this.externalStorage.resolve(FILE_API_KEYS);
			await this.externalStorage.writeJson(keysPath, {
				apiKey:       this.settings.apiKey       ?? "",
				claudeApiKey: this.settings.claudeApiKey ?? "",
				localApiKey:  this.settings.localApiKey  ?? "",
			});
			delete toSave.apiKey;
			delete toSave.claudeApiKey;
			delete toSave.localApiKey;
			await this.saveData(toSave);
		}
	}

	// ── API Keys ───────────────────────────────────────────────────────────────

	private async _loadApiKeys(): Promise<void> {
		if (this.settings.apiKeysInSync) {
			// Sync mode — keys live in data.json, remove any stale keys.json
			if (this.externalStorage.isEnabled) {
				const keysPath = this.externalStorage.resolve(FILE_API_KEYS);
				if (await this.externalStorage.exists(keysPath)) {
					await this.externalStorage.remove(keysPath);
				}
			}
			return;
		}

		// Local mode — keys live in keys.json outside the vault
		if (!this.externalStorage.isEnabled) return; // mobile fallback

		const keysPath = this.externalStorage.resolve(FILE_API_KEYS);

		// If keys.json does not exist there is nothing to load. Keep whatever
		// keys the user has in memory/data.json (the migration branch below
		// will still run for legacy data.json keys).
		if (!(await this.externalStorage.exists(keysPath))) {
			const hasOld = this.settings.apiKey || this.settings.claudeApiKey || this.settings.localApiKey;
			if (hasOld) {
				// Migration: data.json → keys.json
				await this.externalStorage.writeJson(keysPath, {
					apiKey:       this.settings.apiKey       ?? "",
					claudeApiKey: this.settings.claudeApiKey ?? "",
					localApiKey:  this.settings.localApiKey  ?? "",
				});
				delete (this.settings as unknown as Record<string, unknown>).apiKey;
				delete (this.settings as unknown as Record<string, unknown>).claudeApiKey;
				delete (this.settings as unknown as Record<string, unknown>).localApiKey;
				await this.saveData({ ...this.settings });
				this.settings.apiKey       = this.settings.apiKey       ?? "";
				this.settings.claudeApiKey = this.settings.claudeApiKey ?? "";
				this.settings.localApiKey  = this.settings.localApiKey  ?? "";
				new Notice(t("notice_keys_migrated"), 4000);
			}
			return;
		}

		// keys.json exists — read it. Only overwrite settings on a successful
		// read; on a transient read failure preserve the in-memory values to
		// avoid wiping the user's keys.
		const stored = await this.externalStorage.readJson<{ apiKey?: string; claudeApiKey?: string; localApiKey?: string } | null>(keysPath, null);
		if (!stored) {
			console.warn("[AI-Vault] _loadApiKeys: keys.json unreadable, preserving in-memory keys");
			return;
		}

		this.settings.apiKey       = stored.apiKey       ?? this.settings.apiKey       ?? "";
		this.settings.claudeApiKey = stored.claudeApiKey ?? this.settings.claudeApiKey ?? "";
		this.settings.localApiKey  = stored.localApiKey  ?? this.settings.localApiKey  ?? "";
	}

	// ── Auto-migration ─────────────────────────────────────────────────────────

	private async _maybeAutoMigrate(): Promise<void> {
		if (this.settings._externalMigrationDone) return;

		const vaultHistoryIdx = this.storage.resolve("history-index.json");
		const vaultHistoryDir = this.storage.resolve("history");
		const vaultProjects   = this.storage.resolve("projects.json");

		const hasOldData =
			(await this.storage.exists(vaultHistoryIdx)) ||
			(await this.storage.exists(vaultHistoryDir)) ||
			(await this.storage.exists(vaultProjects));

		if (!hasOldData) {
			this.settings._externalMigrationDone = true;
			await this.saveSettings();
			return;
		}

		const result = await this.externalStorage.migrateFromVault();

		if (result.errors.length === 0) {
			this.settings._externalMigrationDone = true;
			await this.saveSettings();
			new Notice(
				t("notice_migration_done", result.moved, this.externalStorage.baseDir ?? ""),
				8000,
			);
		} else {
			console.error("[AI-Vault] Migration errors:", result.errors);
			new Notice(t("notice_migration_partial", result.errors.length), 8000);
		}
	}
}
