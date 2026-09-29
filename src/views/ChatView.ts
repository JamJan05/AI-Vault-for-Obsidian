import {
	Component,
	ItemView,
	Menu,
	Notice,
	setIcon,
	WorkspaceLeaf,
} from "obsidian";
import type { TFile } from "obsidian";

import { CHAT_VIEW_TYPE } from "../constants";
import { t } from "../i18n";
import {
	THINKING_MODES,
	ModelAccessError,
	getFallbackModel,
	supportsWebSearch,
} from "../models";
import { formatDate } from "../utils";
import { callOpenAI }  from "../api/openai";
import { callClaude }  from "../api/anthropic";
import { callLocalApi } from "../api/local";
import { normalizeLocalBaseUrl } from "../api/contracts";
import { assessLocalBaseUrl } from "../security/urlPolicy";
import { sanitizeSources } from "../rag/sources";
import { collectContext } from "../chat/contextCollector";
import { buildExportMarkdown, exportBasePath, firstFreePath, EXPORT_FOLDER } from "../chat/exportNote";
import {
	applyModelChoice,
	buildModelGroups,
	formatModelLabel,
	getActiveModel,
	getProviderIcon,
	getProviderLabel,
} from "../chat/modelOptions";
import { parseQuiz } from "../chat/quiz";
import { composeSystemPrompt } from "../chat/systemPrompt";
import { ConfirmModal } from "./ConfirmModal";
import { FallbackModal } from "./FallbackModal";
import { ModelPicker } from "./ModelPicker";
import { NotePickerModal } from "./NotePickerModal";
import { renderQuiz } from "./QuizRenderer";
import { attachCopyButton, renderMarkdown, setButtonIcon } from "./messageRenderer";
import { describeOutgoing } from "./sendSummary";
import { renderSources } from "./sourceLinks";
import type { ChatMessage, MessageSource } from "../types";
import type { RAGEngine }      from "../rag/RAGEngine";
import type { HistoryManager } from "../history/HistoryManager";
import type { ProjectManager } from "../history/ProjectManager";
import type { PluginSettings, Provider } from "../settings";
import type { StreamResult, StreamUsage } from "../api/streaming";
import type { ModelOption } from "../chat/modelOptions";
import type { ChatMode } from "../chat/systemPrompt";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PluginWithDeps {
	app:              import("obsidian").App;
	settings:         PluginSettings;
	rag:              RAGEngine;
	history:          HistoryManager;
	projects:         ProjectManager;
	currentSessionId: string | null;
	currentSession:   import("../types").ChatSession | null;
	activeProjectId:  string | null;
	saveSettings():   Promise<void>;
	newChat():        void;
	loadSession(id: string): Promise<void>;
	autoSaveSession(messages: ChatMessage[]): Promise<void>;
	setActiveProject(id: string | null): void;
	activateHistoryView():  Promise<void>;
	activateProjectsView(): Promise<void>;
}

const CHAT_MODE_ICONS: Record<ChatMode, string> = {
	chat:  "message-circle",
	learn: "book-open",
	code:  "code",
};

/** What the last buildSystemMessage() put into the prompt. */
interface PreparedPrompt {
	system:  string;
	sources: MessageSource[];
}

// ─── GPTChatView ───────────────────────────────────────────────────────────────

export class GPTChatView extends ItemView {
	// State
	messages:        ChatMessage[] = [];
	webSearchActive  = false;
	chatMode:        ChatMode = "chat";
	manualNotes:     TFile[] = [];
	currentMode:     string | null = null;
	abortController: AbortController | null = null;

	private readonly modelPicker = new ModelPicker();

	private lastUsage: StreamUsage | null = null;

	// Component for MarkdownRenderer — released automatically in onClose()
	private readonly renderComponent: Component;

	// DOM refs
	private chatContainer!:    HTMLElement;
	private inputEl!:          HTMLTextAreaElement;
	private sendBtn!:          HTMLButtonElement;
	private stopBtn:           HTMLButtonElement | null = null;
	private ragStatusEl!:      HTMLElement;
	private ragToggleBtn!:     HTMLButtonElement;
	private webSearchBtn!:     HTMLButtonElement;
	private chatModeBtn!:      HTMLButtonElement;
	private thinkingBtn!:      HTMLButtonElement;
	private summaryEl!:        HTMLElement;
	private modelSelectorBtn!: HTMLButtonElement;
	private projectBar!:       HTMLElement;
	private projectBarLabel!:  HTMLElement;
	private manualBar!:        HTMLElement;
	private manualBarList!:    HTMLElement;
	private modeLabel!:        HTMLElement;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: PluginWithDeps) {
		super(leaf);
		this.renderComponent = new Component();
		this.addChild(this.renderComponent);
	}

	private get settings(): PluginSettings { return this.plugin.settings; }
	private get rag():      RAGEngine      { return this.plugin.rag; }
	private get learnMode(): boolean       { return this.chatMode === "learn"; }
	private get codeMode():  boolean       { return this.chatMode === "code"; }

	getViewType():    string { return CHAT_VIEW_TYPE; }
	getDisplayText(): string { return "AI-Vault"; }
	getIcon():        string { return "message-square"; }

	async onOpen():  Promise<void> { this.buildUI(); await this.maybeAutoIndex(); }
	async onClose(): Promise<void> {
		// Abort any in-flight request so post-stream code does not run after the view is gone
		this.abortController?.abort();
		this.abortController = null;

		this.modelPicker.close();
	}

	// ── Auto-index ─────────────────────────────────────────────────────────────

	private async maybeAutoIndex(): Promise<void> {
		if (!this.settings.ragEnabled || !this.settings.ragAutoIndex) return;
		const loaded = await this.rag.loadIndex();
		if (!loaded) {
			await this.startIndexing();
		} else {
			const s = this.rag.stats;
			this.showRagStatus(t("rag_ready_short", s.files, s.embeddings), "ready");
			window.setTimeout(() => this.hideRagStatus(), 3500);
		}
	}

	private async startIndexing(): Promise<void> {
		if (this.rag.indexing) return;
		this.showRagStatus(t("rag_indexing_status"), "indexing");
		await this.rag.buildIndex((done, total) => {
			if (this.ragStatusEl) this.ragStatusEl.textContent = t("rag_indexing_progress", done, total);
		});
		const s = this.rag.stats;
		this.showRagStatus(t("rag_ready_full", s.files, s.embeddings), "ready");
		this.updateSendSummary();
		window.setTimeout(() => this.hideRagStatus(), 4000);
	}

	private showRagStatus(text: string, state: "indexing" | "ready"): void {
		if (!this.ragStatusEl) return;
		this.ragStatusEl.textContent = text;
		this.ragStatusEl.className   = `gpt-rag-status gpt-rag-${state}`;
		this.ragStatusEl.removeClass("gpt-ctx-hidden");
	}

	private hideRagStatus(): void {
		if (this.ragStatusEl) this.ragStatusEl.addClass("gpt-ctx-hidden");
	}

	// ── Build UI ────────────────────────────────────────────────────────────────

	private buildUI(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("gpt-chat-root");

		this.buildHeader(root);
		this.buildProjectBar(root);
		this.buildRagStatus(root);
		this.buildManualBar(root);
		this.buildChatArea(root);
		this.buildInputArea(root);
	}

	private setButtonIcon(button: HTMLElement, icon: string, label?: string): void {
		setButtonIcon(button, icon, label);
	}

	private buildHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "gpt-header" });
		header.createSpan({ cls: "gpt-header-icon", text: "✦" });

		this.modelSelectorBtn = header.createEl("button", { cls: "gpt-model-selector" });
		this.modelSelectorBtn.onclick = () => this.openModelPicker();
		this.updateModelSelector();

		header.createDiv({ cls: "gpt-header-spacer" });

		const histBtn = header.createEl("button", { cls: "gpt-icon-btn", attr: { "aria-label": t("cmd_open_history") } });
		this.setButtonIcon(histBtn, "history");
		histBtn.onclick   = () => void this.plugin.activateHistoryView();

		const projBtn = header.createEl("button", { cls: "gpt-icon-btn", attr: { "aria-label": t("chat_projects") } });
		this.setButtonIcon(projBtn, "folder");
		projBtn.onclick   = () => void this.plugin.activateProjectsView();

		const moreBtn = header.createEl("button", { cls: "gpt-icon-btn", attr: { "aria-label": t("chat_more") } });
		this.setButtonIcon(moreBtn, "more-horizontal");
		moreBtn.onclick   = (e: MouseEvent) => this.openMoreMenu(e);

		const clearBtn = header.createEl("button", { cls: "gpt-clear-btn", text: t("chat_new") });
		clearBtn.onclick = () => this.plugin.newChat();
	}

	private openMoreMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem(item => item
			.setTitle(t("chat_export_tooltip"))
			.setIcon("file-up")
			.onClick(() => void this.exportToNote()));
		menu.addItem(item => item
			.setTitle(t("chat_title_index"))
			.setIcon("refresh-cw")
			.setDisabled(this.rag.indexing)
			.onClick(() => void this.startIndexing()));
		menu.showAtMouseEvent(event);
	}

	private buildProjectBar(root: HTMLElement): void {
		this.projectBar = root.createDiv({ cls: "gpt-project-bar gpt-ctx-hidden" });
		this.projectBarLabel = this.projectBar.createSpan({ cls: "gpt-project-bar-label" });
		const exitBtn = this.projectBar.createEl("button", { cls: "gpt-ctx-clear", text: "✕" });
		exitBtn.onclick = () => { this.plugin.setActiveProject(null); this.updateProjectBar(); };
		this.updateProjectBar();
	}

	private buildRagStatus(root: HTMLElement): void {
		this.ragStatusEl = root.createDiv({ cls: "gpt-rag-status gpt-ctx-hidden" });
	}

	private buildManualBar(root: HTMLElement): void {
		this.manualBar     = root.createDiv({ cls: "gpt-manual-bar gpt-ctx-hidden" });
		this.manualBarList = this.manualBar.createSpan({ cls: "gpt-ctx-list" });
		const clear = this.manualBar.createEl("button", { cls: "gpt-ctx-clear", text: "✕" });
		clear.onclick = () => { this.manualNotes = []; this.updateManualBar(); };
	}

	private buildChatArea(root: HTMLElement): void {
		this.chatContainer = root.createDiv({ cls: "gpt-messages" });
		this.renderWelcome();
	}

	private buildInputArea(root: HTMLElement): void {
		const area    = root.createDiv({ cls: "gpt-input-area" });
		const toolRow = area.createDiv({ cls: "gpt-tool-row" });

		// RAG toggle
		this.ragToggleBtn = toolRow.createEl("button", {
			cls:  "gpt-tool-btn" + (this.settings.ragEnabled ? " gpt-rag-btn--active" : ""),
			attr: { title: t("chat_title_rag") },
		});
		this.setButtonIcon(this.ragToggleBtn, "database", t("chat_btn_rag"));
		this.ragToggleBtn.onclick   = () => this.toggleRag();

		// Note picker
		const pickBtn = toolRow.createEl("button", { cls: "gpt-tool-btn", attr: { title: t("chat_title_notes") } });
		this.setButtonIcon(pickBtn, "paperclip", t("chat_btn_notes"));
		pickBtn.onclick   = () => this.openNotePicker();

		// Web search
		this.webSearchBtn = toolRow.createEl("button", { cls: "gpt-tool-btn", attr: { title: t("chat_title_internet") } });
		this.setButtonIcon(this.webSearchBtn, "globe", t("chat_btn_internet"));
		this.webSearchBtn.onclick   = () => this.toggleWebSearch();

		// Chat mode — plain chat, learn or code; only one at a time
		this.chatModeBtn = toolRow.createEl("button", { cls: "gpt-tool-btn", attr: { title: t("chat_title_mode") } });
		this.chatModeBtn.onclick    = (e: MouseEvent) => this.openChatModeMenu(e);
		this.updateChatModeButton();

		// What the next message will send, and to whom
		this.summaryEl = area.createDiv({ cls: "gpt-send-summary" });

		// Textarea
		this.inputEl = area.createEl("textarea", {
			cls:  "gpt-input",
			attr: { placeholder: this.getInputPlaceholder(), rows: "3" },
		});
		// registerDomEvent instead of addEventListener — lets Obsidian know this element handles the keyboard
		// prevents Obsidian's global handler from intercepting Enter/shortcuts
		this.registerDomEvent(this.inputEl, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void this.sendMessage(); }
		});

		// Button row
		const btnRow = area.createDiv({ cls: "gpt-btn-row" });
		this.thinkingBtn = btnRow.createEl("button", { cls: "gpt-thinking-btn", attr: { title: t("chat_title_thinking") } });
		this.thinkingBtn.onclick = (e: MouseEvent) => this.openThinkingMenu(e);
		this.modeLabel = btnRow.createSpan({ cls: "gpt-mode-label" });
		this.setMode(this.settings.thinkingMode);

		this.sendBtn = btnRow.createEl("button", { cls: "gpt-send-btn", text: t("chat_send") });
		this.sendBtn.onclick = () => void this.sendMessage();

		this.updateSendSummary();
	}

	// ── Note picker ─────────────────────────────────────────────────────────────

	private openNotePicker(): void {
		// The picker intentionally lists eligible vault files after explicit user action.
		const files = this.plugin.app.vault.getFiles()
			.filter((file: TFile) => file.extension === "md" || file.extension === "canvas")
			.sort((a, b) => a.basename.localeCompare(b.basename));

		new NotePickerModal(this.plugin.app, files, this.manualNotes, picked => {
			this.manualNotes = picked;
			this.updateManualBar();
			if (picked.length) new Notice(t("chat_notes_added", picked.length));
		}).open();
	}

	updateManualBar(): void {
		if (!this.manualBar) return;
		if (!this.manualNotes.length) {
			this.manualBar.addClass("gpt-ctx-hidden");
			this.manualBarList.textContent = "";
			this.updateSendSummary();
			return;
		}
		this.manualBar.removeClass("gpt-ctx-hidden");
		this.manualBarList.textContent = "📎 " + this.manualNotes.map(f => f.basename).join(", ");
		this.updateSendSummary();
	}

	/** Refreshes the line that says what the next message will send, and to whom. */
	updateSendSummary(): void {
		if (!this.summaryEl) return;
		const summary = describeOutgoing({
			provider:       this.settings.provider,
			localBaseUrl:   this.settings.localBaseUrl ?? "",
			ragActive:      this.settings.ragEnabled && this.rag.indexed,
			semanticActive: this.rag.embeddingsAllowed,
			attachedNotes:  this.manualNotes.length,
			webSearch:      this.webSearchActive,
			projectActive:  Boolean(this.plugin.activeProjectId),
			historyLimit:   this.settings.maxContextMessages ?? 0,
		});
		this.summaryEl.textContent = summary.text;
		this.summaryEl.classList.toggle("gpt-send-summary--warning", summary.warning);
	}

	// ── Controls ────────────────────────────────────────────────────────────────

	toggleRag(): void {
		this.settings.ragEnabled = !this.settings.ragEnabled;
		void this.plugin.saveSettings();
		this.ragToggleBtn.classList.toggle("gpt-rag-btn--active", this.settings.ragEnabled);
		this.updateSendSummary();
		new Notice(this.settings.ragEnabled ? t("rag_on_notice") : t("rag_off_notice"));
	}

	updateProjectBar(): void {
		this.updateSendSummary();
		if (!this.projectBar) return;
		const projId = this.plugin.activeProjectId;
		if (!projId) {
			this.projectBar.addClass("gpt-ctx-hidden");
			this.projectBarLabel.textContent = "";
			return;
		}
		const proj = this.plugin.projects.getProject(projId);
		if (!proj) { this.projectBar.addClass("gpt-ctx-hidden"); return; }

		this.projectBar.removeClass("gpt-ctx-hidden");
		this.projectBar.setCssProps({ "--gpt-project-color": proj.color });

		const sessions    = this.plugin.projects.getProjectSessions(proj.id);
		const promptBadge = proj.systemPrompt ? " " + t("projects_custom_prompt_badge") : "";
		this.projectBarLabel.textContent = t("projects_bar_label", proj.name, sessions.length) + promptBadge;
	}

	setMode(key: string): void {
		this.currentMode = THINKING_MODES[key] ? key : "normal";
		if (!this.thinkingBtn) return;

		const mode = THINKING_MODES[this.currentMode];
		this.thinkingBtn.empty();
		this.thinkingBtn.createSpan({ text: mode.label });
		const arrow = this.thinkingBtn.createSpan({ cls: "gpt-ms-arrow" });
		setIcon(arrow, "chevron-down");
	}

	private openThinkingMenu(event: MouseEvent): void {
		const menu = new Menu();
		for (const [key, mode] of Object.entries(THINKING_MODES)) {
			menu.addItem(item => item
				.setTitle(`${mode.label} — ${mode.desc}`)
				.setChecked(key === this.currentMode)
				.onClick(() => this.setMode(key)));
		}
		menu.showAtMouseEvent(event);
	}

	private getChatModeLabel(mode: ChatMode): string {
		if (mode === "learn") return t("chat_btn_learn");
		if (mode === "code")  return t("chat_btn_code");
		return t("chat_btn_chat");
	}

	private getChatModeDesc(mode: ChatMode): string {
		if (mode === "learn") return t("chat_title_learn");
		if (mode === "code")  return t("chat_title_code");
		return t("chat_title_chat");
	}

	private updateChatModeButton(): void {
		if (!this.chatModeBtn) return;
		this.setButtonIcon(this.chatModeBtn, CHAT_MODE_ICONS[this.chatMode], this.getChatModeLabel(this.chatMode));
		this.chatModeBtn.classList.toggle("gpt-learn-btn--active", this.chatMode === "learn");
		this.chatModeBtn.classList.toggle("gpt-code-btn--active", this.chatMode === "code");
	}

	private openChatModeMenu(event: MouseEvent): void {
		const menu = new Menu();
		for (const mode of ["chat", "learn", "code"] as const) {
			menu.addItem(item => item
				.setTitle(this.getChatModeDesc(mode))
				.setIcon(CHAT_MODE_ICONS[mode])
				.setChecked(mode === this.chatMode)
				.onClick(() => this.setChatMode(mode)));
		}
		menu.showAtMouseEvent(event);
	}

	setChatMode(mode: ChatMode): void {
		if (mode === this.chatMode) return;
		this.chatMode = mode;
		this.updateChatModeButton();
		if (this.inputEl) this.inputEl.placeholder = this.getInputPlaceholder();
		new Notice(t("chat_mode_changed", this.getChatModeLabel(mode)));
	}

	private getInputPlaceholder(): string {
		if (this.chatMode === "learn") return t("chat_placeholder_learn");
		if (this.chatMode === "code")  return t("chat_placeholder_code");
		return this.getProviderPlaceholder(this.settings.provider);
	}

	private getCurrentActiveModel(): string {
		return getActiveModel(this.settings);
	}

	private getEffectiveProvider(): Provider {
		return this.settings.provider;
	}

	private getProviderPlaceholder(provider: Provider): string {
		if (provider === "anthropic") return t("chat_placeholder_claude");
		if (provider === "local") return t("chat_placeholder_ollama");
		return t("chat_placeholder");
	}

	private disableUnsupportedWebSearch(provider: Provider, model: string): void {
		if (!this.webSearchActive) return;
		if (supportsWebSearch(provider, model)) return;

		this.webSearchActive = false;
		this.webSearchBtn?.classList.remove("gpt-websearch-btn--active");
		this.updateSendSummary();
	}

	toggleWebSearch(): void {
		const activeModel = this.getCurrentActiveModel();
		const provider = this.getEffectiveProvider();

		if (!this.webSearchActive && provider === "local") {
			new Notice(t("ws_ollama_unsupported"), 7000);
			return;
		}
		if (!this.webSearchActive && !supportsWebSearch(provider, activeModel)) {
			new Notice(t("ws_unsupported", activeModel), 7000);
			return;
		}
		this.webSearchActive = !this.webSearchActive;
		this.webSearchBtn.classList.toggle("gpt-websearch-btn--active", this.webSearchActive);
		this.updateSendSummary();

		if (this.webSearchActive && provider === "anthropic") {
			new Notice(t("ws_claude_enabled", activeModel));
		} else {
			new Notice(this.webSearchActive
				? t("ws_enabled", activeModel)
				: t("ws_disabled"));
		}
	}

	updateModelSelector(): void {
		if (!this.modelSelectorBtn) return;
		const model = this.getCurrentActiveModel();
		const provider = this.settings.provider;

		this.modelSelectorBtn.empty();
		this.modelSelectorBtn.classList.toggle("gpt-model-selector--openai", provider === "openai");
		this.modelSelectorBtn.classList.toggle("gpt-model-selector--claude", provider === "anthropic");
		this.modelSelectorBtn.classList.toggle("gpt-model-selector--local", provider === "local");
		this.modelSelectorBtn.createSpan({ cls: "gpt-ms-icon", text: getProviderIcon(provider) });
		this.modelSelectorBtn.createSpan({
			cls:  "gpt-ms-label",
			text: model ? formatModelLabel(model) : t("chat_model_none"),
		});
		const arrow = this.modelSelectorBtn.createSpan({ cls: "gpt-ms-arrow" });
		setIcon(arrow, "chevron-down");
		this.modelSelectorBtn.title = t("chat_model_tooltip", model);

		if (this.inputEl) this.inputEl.placeholder = this.getInputPlaceholder();
		this.updateSendSummary();
	}

	private async selectModel(provider: Provider, model: ModelOption): Promise<void> {
		applyModelChoice(this.settings, provider, model.id);
		this.disableUnsupportedWebSearch(provider, model.id);
		this.updateModelSelector();
		try {
			await this.plugin.saveSettings();
			new Notice(t("notice_model_changed", model.label), 2000);
		} catch (err) {
			console.error("[AI-Vault] Failed to save selected model:", (err as Error)?.message);
		}
	}

	private openModelPicker(): void {
		// Toggle: if the picker is already open — close it
		if (this.modelPicker.isOpen) {
			this.modelPicker.close();
			return;
		}
		this.modelPicker.open({
			anchor:   this.modelSelectorBtn,
			groups:   buildModelGroups(this.settings),
			active:   { provider: this.settings.provider, model: this.getCurrentActiveModel() },
			onSelect: (provider, model) => void this.selectModel(provider, model),
		});
	}

	// ── Sessions ────────────────────────────────────────────────────────────────

	loadSession(session: { title: string; messages: ChatMessage[]; model?: string }): void {
		this.messages  = [...session.messages];
		this.lastUsage = null;
		this.chatContainer.empty();

		if (!this.messages.length) { this.renderWelcome(); return; }
		for (const msg of this.messages) {
			const bubble = this.appendMessage(msg.role, msg.content);
			// Read back from disk, so validated before anything is drawn.
			if (msg.role === "assistant") renderSources(this.plugin.app, bubble, sanitizeSources(msg.sources));
		}

		if (this.modelSelectorBtn && session.model) {
			this.modelSelectorBtn.title = t("chat_model_session_tooltip", session.title, session.model);
		}
	}

	clearAndNew(): void {
		this.messages    = [];
		this.manualNotes = [];
		this.lastUsage   = null;
		this.updateManualBar();
		this.chatContainer.empty();
		this.renderWelcome();
		if (this.modeLabel) { this.modeLabel.textContent = ""; this.modeLabel.title = ""; }
		this.updateModelSelector();
	}

	// ── Send message ─────────────────────────────────────────────────────────────

	async sendMessage(override?: string): Promise<void> {
		const userText = override ?? this.inputEl.value.trim();
		if (!userText) return;

		const activeModel = this.getCurrentActiveModel();
		const activeProvider = this.getEffectiveProvider();
		const webSearchEnabled = this.webSearchActive && supportsWebSearch(activeProvider, activeModel);
		if (activeProvider === "openai" && !this.settings.apiKey) { new Notice(t("err_no_openai_key")); return; }
		if (activeProvider === "anthropic" && !this.settings.claudeApiKey) { new Notice(t("err_no_claude_key")); return; }
		if (activeProvider === "local" && !this.settings.localBaseUrl.trim()) { new Notice(t("err_no_ollama_url")); return; }
		if (activeProvider === "local" && !(await this.confirmPlainHttpEndpoint())) return;

		if (!override) this.inputEl.value = "";
		this.sendBtn.disabled = true;
		// A failed exchange left on screen is superseded by this message.
		this.chatContainer.querySelectorAll(".gpt-msg-failed").forEach(el => el.remove());
		this.messages.push({ role: "user", content: userText });
		const userMsgEl = this.appendMessage("user", userText).parentElement;

		const bubble = this.appendMessage("assistant", "");
		this.setLoading(bubble, true, webSearchEnabled);

		try {
			const prepared   = await this.buildSystemMessage(userText);
			const systemMsg  = prepared.system;
			const ragSources = prepared.sources;

			const ctxLimit  = this.settings.maxContextMessages ?? 0;
			const histMsgs  = ctxLimit > 0 ? this.messages.slice(-ctxLimit) : this.messages;
			const msgs: ChatMessage[] = [{ role: "system", content: systemMsg }, ...histMsgs];
			const contentEl = bubble.querySelector<HTMLElement>(".gpt-msg-content");

			this.abortController = new AbortController();
			this.showStopBtn(true);

			// Providers answer with one complete response (requestUrl cannot stream),
			// so this runs once, when the answer has arrived.
			const onChunk = (): void => { this.setLoading(bubble, false); };

			const activeMode = this.currentMode ?? this.settings.thinkingMode;
			let result: StreamResult;
			if (activeProvider === "anthropic") {
				result = await callClaude(
					this.settings.claudeApiKey,
					activeModel,
					msgs,
					activeMode,
					webSearchEnabled, onChunk, this.abortController.signal,
					this.getMaxTokensForMode(activeMode),
				);
			} else if (activeProvider === "local") {
				const text = await callLocalApi(this.settings, msgs, {
					maxTokens: this.getMaxTokensForMode(activeMode),
					signal:    this.abortController.signal,
				});
				onChunk();
				result = { text, usage: null };
			} else {
				result = await callOpenAI(
					this.settings.apiKey,
					activeModel,
					msgs,
					activeMode,
					webSearchEnabled, onChunk, this.abortController.signal,
					this.getMaxTokensForMode(activeMode),
				);
			}

			const { text: reply, usage } = result;
			this.setLoading(bubble, false);

			if (contentEl) this.renderAnswer(contentEl, reply);
			bubble.dataset.raw = reply;

			// The provider answered with another model (refusal fallback) — say so.
			if (result.servedBy) {
				bubble.createDiv({ cls: "gpt-msg-served-by", text: t("chat_served_by", result.servedBy) });
			}

			renderSources(this.plugin.app, bubble, ragSources);

			const answer: ChatMessage = { role: "assistant", content: reply };
			if (ragSources.length) answer.sources = ragSources;
			this.messages.push(answer);

			// Token stats
			this.lastUsage = usage;
			if (usage) {
				this.updateTokenCounter(usage.input + usage.output, usage);
			} else {
				const totalChars = this.messages.reduce((s, m) => s + m.content.length, 0) + systemMsg.length;
				this.updateTokenCounter(Math.round(totalChars / 4), null);
			}

			await this.plugin.autoSaveSession(this.messages);

		} catch (err: unknown) {
			this.setLoading(bubble, false);
			const error     = err as Error & { name?: string };
			const isAbort   = error.name === "AbortError";
			const contentEl = bubble.querySelector<HTMLElement>(".gpt-msg-content");

			if (isAbort) {
				// Nothing was answered: take the question back out of the transcript
				// and hand it back to the user instead of losing it.
				this.messages.pop();
				bubble.parentElement?.remove();
				userMsgEl?.remove();
				if (!this.inputEl.value.trim()) this.inputEl.value = userText;
			} else if (err instanceof ModelAccessError && activeProvider === "openai") {
				// The retry from the dialog sends — and draws — the question again.
				this.messages.pop();
				bubble.parentElement?.remove();
				userMsgEl?.remove();
				const failed   = error.message;
				const failedModel  = err.model ?? activeModel;
				const fallbackModel = getFallbackModel(failedModel);
				new FallbackModal(this.plugin.app, {
					failedModel,
					fallbackModel,
					errorMessage: failed,
					onAccept: async (saveAsDefault: boolean) => {
						this.plugin.settings.provider = "openai";
						this.plugin.settings.model = fallbackModel;
						this.updateModelSelector();
						if (saveAsDefault) await this.plugin.saveSettings();
						new Notice(t("notice_fallback_switched", fallbackModel));
						await this.sendMessage(userText);
					},
				}).open();
			} else {
				// The exchange is not part of the conversation. Both bubbles stay
				// visible but are marked, so they are never counted as messages.
				this.messages.pop();
				userMsgEl?.addClass("gpt-msg-failed");
				bubble.parentElement?.addClass("gpt-msg-failed");
				if (contentEl) {
					contentEl.empty();
					contentEl.createDiv({ cls: "gpt-msg-error-line", text: `❌ ${t("err_stream")}: ${error.message}` });
					contentEl.createDiv({ cls: "gpt-msg-error-detail", text: t("err_detail", activeModel, this.currentMode ?? "") });
					contentEl.addClass("gpt-error");
				}
				console.error("[AI-Vault] sendMessage error:", error.message, err);
			}
		} finally {
			this.sendBtn.disabled = false;
			this.showStopBtn(false);
			this.abortController  = null;
			this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			this.updateSendSummary();
		}
	}

	/** Base URLs the user has agreed to use over plain HTTP, for this session only. */
	private readonly acceptedPlainHttp = new Set<string>();

	/**
	 * Asks before the first message to a remote Local API over plain HTTP.
	 * @returns false when the user declined and nothing may be sent
	 */
	private confirmPlainHttpEndpoint(): Promise<boolean> {
		const base = normalizeLocalBaseUrl(this.settings.localBaseUrl, this.settings.localApiType);
		const assessment = assessLocalBaseUrl(base);
		if (assessment.verdict !== "remote-http" || this.acceptedPlainHttp.has(base)) {
			return Promise.resolve(true);
		}

		return new Promise<boolean>(resolve => {
			let accepted = false;
			const modal = new ConfirmModal(
				this.plugin.app,
				t("confirm_plain_http", assessment.hostname ?? base),
				() => { accepted = true; this.acceptedPlainHttp.add(base); },
				t("confirm_plain_http_accept"),
				t("chat_notes_cancel"),
			);
			// Escape and the close button count as declining.
			const close = modal.onClose.bind(modal);
			modal.onClose = (): void => { close(); resolve(accepted); };
			modal.open();
		});
	}

	// ── System message builder ──────────────────────────────────────────────────

	private async buildSystemMessage(userText: string): Promise<PreparedPrompt> {
		const projId  = this.plugin.activeProjectId;
		const project = projId ? this.plugin.projects.getProject(projId) : null;

		const context = await collectContext({
			app:         this.plugin.app,
			rag:         this.rag,
			ragEnabled:  this.settings.ragEnabled,
			manualNotes: this.manualNotes,
			userText,
		});

		let projectContext = "";
		if (projId && this.plugin.currentSessionId) {
			projectContext = await this.plugin.projects.buildProjectContext(projId, this.plugin.currentSessionId);
		}

		const system = composeSystemPrompt({
			basePrompt: project?.systemPrompt || this.settings.systemPrompt,
			chatMode:   this.chatMode,
			attached:   context.attached,
			retrieved:  context.retrieved,
			project:    projectContext ? { name: project?.name ?? "Project", context: projectContext } : null,
		});

		return { system, sources: context.sources };
	}

	// ── UI helpers ──────────────────────────────────────────────────────────────

	renderWelcome(): void {
		const w = this.chatContainer.createDiv({ cls: "gpt-welcome" });
		w.createDiv({ cls: "gpt-welcome-icon", text: "✦" });
		w.createEl("p", { text: t("chat_welcome_rag") });
		w.createEl("p", { cls: "gpt-welcome-hint", text: t("chat_welcome_hint") });
	}

	appendMessage(role: string, content: string): HTMLElement {
		this.chatContainer.querySelector(".gpt-welcome")?.remove();
		const msgEl     = this.chatContainer.createDiv({ cls: `gpt-msg gpt-msg-${role}` });
		const bubble    = msgEl.createDiv({ cls: "gpt-bubble" });
		const contentEl = bubble.createDiv({ cls: "gpt-msg-content" });

		if (content) {
			if (role === "assistant") this.renderAnswer(contentEl, content);
			else this.renderContent(contentEl, content);
		}

		// Footer with copy button
		const footer      = msgEl.createDiv({ cls: "gpt-msg-footer" });
		const assistLabel = getProviderLabel(this.getEffectiveProvider());
		footer.createSpan({ cls: "gpt-msg-label", text: role === "user" ? t("chat_role_you") : assistLabel });

		const copyBtn = footer.createEl("button", { cls: "gpt-copy-btn", attr: { title: t("chat_copy"), "aria-label": t("chat_copy") } });
		attachCopyButton(copyBtn, () => bubble.dataset.raw ?? contentEl.innerText);

		if (role === "assistant") {
			// Styled to show on the last message only — see styles.css.
			const regenBtn = footer.createEl("button", {
				cls:  "gpt-copy-btn gpt-regen-btn",
				attr: { title: t("chat_regen_tooltip"), "aria-label": t("chat_regen_tooltip") },
			});
			this.setButtonIcon(regenBtn, "refresh-cw");
			regenBtn.onclick = () => void this.regenerateLastMessage();
		}

		if (role === "user" || content) bubble.dataset.raw = content;
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
		return bubble;
	}

	private setLoading(bubble: HTMLElement, on: boolean, webSearch = false): void {
		bubble.querySelector(".gpt-dots")?.remove();
		bubble.querySelector(".gpt-websearch-indicator")?.remove();
		if (on) {
			bubble.addClass("gpt-loading");
			const dots = bubble.createDiv({ cls: "gpt-dots" });
			dots.createSpan(); dots.createSpan(); dots.createSpan();
			if (webSearch) {
				const ind = bubble.createDiv({ cls: "gpt-websearch-indicator" });
				setIcon(ind, "globe");
				ind.createSpan({ text: t("ws_searching_label") });
			}
		} else {
			bubble.removeClass("gpt-loading");
		}
	}

	private showStopBtn(show: boolean): void {
		if (show) {
			if (this.stopBtn) return;
			this.stopBtn = this.sendBtn.parentElement!.createEl("button", {
				cls:  "gpt-stop-btn",
				text: `⏹ ${t("chat_stop")}`,
			});
			this.stopBtn.onclick = () => {
				this.abortController?.abort();
				new Notice(t("chat_generation_stopped"));
			};
			this.sendBtn.addClass("gpt-ctx-hidden");
		} else {
			this.stopBtn?.remove();
			this.stopBtn = null;
			this.sendBtn.removeClass("gpt-ctx-hidden");
		}
	}

	private updateTokenCounter(tokens: number, usage: StreamUsage | null): void {
		if (!this.modeLabel) return;
		const fmt = (n: number): string => n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
		const parts: string[] = [];

		if (usage) {
			parts.push(t("tokens_total", fmt(usage.input + usage.output)));
			parts.push(t("tokens_in", fmt(usage.input)));
			parts.push(t("tokens_out", fmt(usage.output)));
			if (usage.reasoning > 0) parts.push(t("tokens_reasoning", fmt(usage.reasoning)));
		} else {
			parts.push(t("tokens_total", `~${fmt(tokens)}`));
		}

		this.modeLabel.textContent = parts.join(" · ");
		this.modeLabel.title = "";
	}

	async regenerateLastMessage(): Promise<void> {
		if (this.abortController) return;

		// A failed exchange is not in this.messages — retry it from what is on screen.
		const failed = Array.from(this.chatContainer.querySelectorAll<HTMLElement>(".gpt-msg-failed"));
		const failedUser = failed.filter(el => el.hasClass("gpt-msg-user")).pop();
		if (failedUser) {
			const text = failedUser.querySelector<HTMLElement>(".gpt-bubble")?.dataset.raw ?? "";
			for (const el of failed) el.remove();
			if (text) await this.sendMessage(text);
			return;
		}

		let idx = -1;
		for (let i = this.messages.length - 1; i >= 0; i--) {
			if (this.messages[i].role === "user") { idx = i; break; }
		}
		if (idx < 0) return;

		const userText = this.messages[idx].content;
		this.messages  = this.messages.slice(0, idx);
		// Failed exchanges are on screen but not in this.messages, so they are
		// left out when matching bubbles to messages.
		const shown = this.chatContainer.querySelectorAll(".gpt-msg:not(.gpt-msg-failed)");
		for (let i = shown.length - 1; i >= idx; i--) shown[i].remove();
		await this.sendMessage(userText);
	}

	async exportToNote(): Promise<void> {
		if (!this.messages.length) { new Notice(t("export_no_messages")); return; }
		const { vault } = this.plugin.app;
		const title = this.plugin.currentSession?.title ?? t("projects_chat_fallback");

		const markdown = buildExportMarkdown({
			title,
			model:         this.getCurrentActiveModel(),
			providerLabel: getProviderLabel(this.getEffectiveProvider()),
			date:          formatDate(Date.now()),
			messages:      this.messages,
		});

		if (!vault.getAbstractFileByPath(EXPORT_FOLDER)) {
			try { await vault.createFolder(EXPORT_FOLDER); } catch { /* already exists */ }
		}
		const path = firstFreePath(
			exportBasePath(title, new Date()),
			candidate => vault.getAbstractFileByPath(candidate) !== null,
		);

		try {
			await vault.create(path, markdown);
			new Notice(t("notice_export_done", path));
		} catch (e) {
			new Notice(t("notice_export_fail", (e as Error).message));
		}
	}

	// ── Rendering ────────────────────────────────────────────────────────────────

	/** Final render — native Obsidian renderer */
	private renderContent(el: HTMLElement, text: string): void {
		void renderMarkdown(this.plugin.app, this.renderComponent, el, text);
	}

	/** An answer is a quiz in Learn mode when the model returned one, otherwise Markdown. */
	private renderAnswer(el: HTMLElement, text: string): void {
		const quiz = this.learnMode ? parseQuiz(text) : null;
		if (quiz) renderQuiz(el, quiz, prompt => this.gradeQuizAnswer(prompt));
		else this.renderContent(el, text);
	}

	/** Asks the active model to grade an open quiz answer. */
	private async gradeQuizAnswer(prompt: string): Promise<string> {
		const model    = this.getCurrentActiveModel();
		const provider = this.getEffectiveProvider();
		const messages: ChatMessage[] = [{ role: "user", content: prompt }];

		if (provider === "anthropic") {
			return (await callClaude(this.settings.claudeApiKey, model, messages, "fast")).text;
		}
		if (provider === "local") {
			if (!(await this.confirmPlainHttpEndpoint())) throw new Error("declined");
			return callLocalApi(this.settings, messages, { maxTokens: this.getMaxTokensForMode("fast") });
		}
		return (await callOpenAI(this.settings.apiKey, model, messages, "fast")).text;
	}

	private getMaxTokensForMode(mode: string): number {
		switch (mode) {
			case "fast":   return this.settings.maxTokensFast   ?? 4096;
			case "normal": return this.settings.maxTokensNormal ?? 8192;
			case "think":  return this.settings.maxTokensThink  ?? 16000;
			default:       return this.settings.maxTokensNormal ?? 8192;
		}
	}
}
