import {
	Component,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Notice,
	setIcon,
	TFile,
	WorkspaceLeaf,
} from "obsidian";

import { CHAT_VIEW_TYPE, RAG_TOP_K } from "../constants";
import { t } from "../i18n";
import {
	DEFAULT_CLAUDE_MODEL,
	DEFAULT_OPENAI_MODEL,
	THINKING_MODES,
	ModelAccessError,
	findCatalogEntry,
	getCatalogModels,
	getFallbackModel,
	supportsWebSearch,
} from "../models";
import { formatDate } from "../utils";
import { callOpenAI }  from "../api/openai";
import { callClaude }  from "../api/anthropic";
import { callLocalApi } from "../api/local";
import { parseCanvasToText }   from "../rag/canvasParser";
import { resolveNoteWithLinks } from "../rag/linkResolver";
import { locateChunk } from "../rag/locate";
import { FallbackModal } from "./FallbackModal";
import { ConfirmModal } from "./ConfirmModal";
import { normalizeLocalBaseUrl } from "../api/contracts";
import { assessLocalBaseUrl } from "../security/urlPolicy";
import { NotePickerModal } from "./NotePickerModal";
import { describeOutgoing } from "./sendSummary";
import type { ChatMessage } from "../types";
import type { RAGEngine }      from "../rag/RAGEngine";
import type { HistoryManager } from "../history/HistoryManager";
import type { ProjectManager } from "../history/ProjectManager";
import type { PluginSettings, Provider } from "../settings";
import type { StreamResult, StreamUsage } from "../api/streaming";

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

interface QuizQuestion {
	question:     string;
	type:         string;
	options?:     string[];
	correct?:     number;
	answer?:      string;
	explanation?: string;
	[key: string]: unknown;
}

const MAX_SYSTEM_CHARS   = 120_000;

/** A note that was put into the prompt, shown under the answer. */
interface SourceRef {
	label: string;
	path:  string;
	/** The fragment that was sent, when the source came from a search. */
	chunk?: string;
}

interface ModelOption {
	id:     string;
	label:  string;
	desc:   () => string;
	legacy: boolean;
}

type ChatMode = "chat" | "learn" | "code";

const CHAT_MODE_ICONS: Record<ChatMode, string> = {
	chat:  "message-circle",
	learn: "book-open",
	code:  "code",
};

interface ModelGroup {
	provider: Provider;
	title:    string;
	models:   ModelOption[];
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

	// Reference to the open model picker and its global mousedown handler
	private currentPicker:       HTMLElement | null = null;
	private pickerCloseHandler: ((e: MouseEvent) => void) | null = null;

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

		if (this.pickerCloseHandler) {
			const doc = this.currentPicker?.ownerDocument ?? this.containerEl.ownerDocument;
			doc.removeEventListener("mousedown", this.pickerCloseHandler);
			this.pickerCloseHandler = null;
		}
		this.currentPicker?.remove();
		this.currentPicker = null;
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
		button.empty();
		setIcon(button, icon);
		if (label) button.createEl("span", { text: label });
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
		this.projectBar = root.createEl("div", { cls: "gpt-project-bar gpt-ctx-hidden" });
		this.projectBarLabel = this.projectBar.createEl("span", { cls: "gpt-project-bar-label" });
		const exitBtn = this.projectBar.createEl("button", { cls: "gpt-ctx-clear", text: "✕" });
		exitBtn.onclick = () => { this.plugin.setActiveProject(null); this.updateProjectBar(); };
		this.updateProjectBar();
	}

	private buildRagStatus(root: HTMLElement): void {
		this.ragStatusEl = root.createEl("div", { cls: "gpt-rag-status gpt-ctx-hidden" });
	}

	private buildManualBar(root: HTMLElement): void {
		this.manualBar     = root.createEl("div", { cls: "gpt-manual-bar gpt-ctx-hidden" });
		this.manualBarList = this.manualBar.createEl("span", { cls: "gpt-ctx-list" });
		const clear = this.manualBar.createEl("button", { cls: "gpt-ctx-clear", text: "✕" });
		clear.onclick = () => { this.manualNotes = []; this.updateManualBar(); };
	}

	private buildChatArea(root: HTMLElement): void {
		this.chatContainer = root.createEl("div", { cls: "gpt-messages" });
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
		const provider = this.settings.provider;
		if (provider === "anthropic") return this.settings.claudeModel ?? DEFAULT_CLAUDE_MODEL;
		if (provider === "local") return this.settings.localModel?.trim() ?? "";
		return this.settings.model ?? DEFAULT_OPENAI_MODEL;
	}

	private getEffectiveProvider(): Provider {
		return this.settings.provider;
	}

	private getProviderLabel(provider: Provider): string {
		if (provider === "anthropic") return "Claude";
		if (provider === "local") return "Local API";
		return "GPT";
	}

	private getProviderIcon(provider: Provider): string {
		if (provider === "anthropic") return "🟣";
		if (provider === "local") return "🖥️";
		return "🤖";
	}

	private getProviderPlaceholder(provider: Provider): string {
		if (provider === "anthropic") return t("chat_placeholder_claude");
		if (provider === "local") return t("chat_placeholder_ollama");
		return t("chat_placeholder");
	}

	private formatModelLabel(model: string): string {
		return findCatalogEntry(model)?.label ?? model;
	}

	private getLocalModelsForPicker(): ModelOption[] {
		const models  = [...(this.settings.localModelsCache ?? [])];
		const current = this.settings.localModel?.trim();
		if (current && !models.includes(current)) models.unshift(current);
		return models.map(model => ({
			id: model, label: model, desc: () => t("model_desc_ollama"), legacy: false,
		}));
	}

	private getModelsForProvider(provider: Provider): ModelOption[] {
		if (provider === "local") return this.getLocalModelsForPicker();
		return getCatalogModels(provider).map(entry => ({
			id:     entry.id,
			label:  entry.label,
			desc:   () => t(entry.descKey),
			legacy: entry.legacy,
		}));
	}

	/** Every provider in one list — picking a model also picks its provider. */
	private getModelPickerGroups(): ModelGroup[] {
		const providers: Provider[] = ["openai", "anthropic", "local"];
		const active      = this.settings.provider;
		const activeModel = this.getCurrentActiveModel();

		return providers.map(provider => {
			const models = this.getModelsForProvider(provider);
			// A model id typed by hand in settings is not in the catalogue.
			if (provider === active && activeModel && !models.some(m => m.id === activeModel)) {
				models.unshift({
					id: activeModel, label: activeModel, desc: () => t("model_desc_custom"), legacy: false,
				});
			}
			return { provider, title: this.getModelPickerTitle(provider), models };
		});
	}

	private getModelPickerTitle(provider: Provider): string {
		if (provider === "anthropic") return t("chat_picker_claude");
		if (provider === "local") return t("chat_picker_ollama");
		return t("chat_picker_openai");
	}

	private setActiveModel(provider: Provider, model: string): void {
		this.settings.provider = provider;
		if (provider === "openai") {
			this.settings.model = model;
		} else if (provider === "anthropic") {
			this.settings.claudeModel = model;
		} else {
			this.settings.localModel = model;
		}
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
		this.modelSelectorBtn.createSpan({ cls: "gpt-ms-icon", text: this.getProviderIcon(provider) });
		this.modelSelectorBtn.createSpan({
			cls:  "gpt-ms-label",
			text: model ? this.formatModelLabel(model) : t("chat_model_none"),
		});
		const arrow = this.modelSelectorBtn.createSpan({ cls: "gpt-ms-arrow" });
		setIcon(arrow, "chevron-down");
		this.modelSelectorBtn.title = t("chat_model_tooltip", model);

		if (this.inputEl) this.inputEl.placeholder = this.getInputPlaceholder();
		this.updateSendSummary();
	}

	private closePicker(): void {
		if (this.pickerCloseHandler) {
			const doc = this.currentPicker?.ownerDocument ?? this.containerEl.ownerDocument;
			doc.removeEventListener("mousedown", this.pickerCloseHandler);
			this.pickerCloseHandler = null;
		}
		this.currentPicker?.remove();
		this.currentPicker = null;
	}

	private async selectModel(provider: Provider, model: ModelOption): Promise<void> {
		this.closePicker();
		this.setActiveModel(provider, model.id);
		this.disableUnsupportedWebSearch(provider, model.id);
		this.updateModelSelector();
		try {
			await this.plugin.saveSettings();
			new Notice(t("notice_model_changed", model.label), 2000);
		} catch (err) {
			console.error("[AI-Vault] Failed to save selected model:", err);
		}
	}

	private openModelPicker(): void {
		// Toggle: if the picker is already open — close it
		if (this.currentPicker) {
			this.closePicker();
			return;
		}

		const activeProvider = this.settings.provider;
		const activeId = this.getCurrentActiveModel();
		const doc = this.containerEl.ownerDocument;

		// Attached to the view document body — avoids CSS transform issues on Obsidian panels
		const picker = doc.body.createDiv({ cls: "gpt-model-picker" });
		this.currentPicker = picker;

		for (const group of this.getModelPickerGroups()) {
			picker.createDiv({ cls: "gpt-mp-header", text: group.title });

			if (!group.models.length) {
				picker.createDiv({ cls: "gpt-mp-empty", text: t("chat_picker_local_empty") });
				continue;
			}

			let legacyShown = false;
			for (const model of group.models) {
				if (model.legacy && !legacyShown) {
					picker.createDiv({ cls: "gpt-mp-subheader", text: t("chat_picker_legacy") });
					legacyShown = true;
				}

				const isActive = group.provider === activeProvider && model.id === activeId;
				const row = picker.createEl("button", {
					cls:  "gpt-mp-row" + (isActive ? " gpt-mp-row--active" : ""),
					attr: { type: "button" },
				});

				const left = row.createSpan({ cls: "gpt-mp-row-left" });
				left.createSpan({ cls: "gpt-mp-row-name", text: model.label });
				left.createSpan({ cls: "gpt-mp-row-desc", text: model.desc() });
				if (isActive) row.createSpan({ cls: "gpt-mp-row-check", text: "✓" });

				row.addEventListener("mousedown", (e) => e.stopPropagation());
				row.addEventListener("click", () => void this.selectModel(group.provider, model));
			}
		}

		const rect = this.modelSelectorBtn.getBoundingClientRect();
		picker.setCssStyles({
			top:  `${rect.bottom + 4}px`,
			left: `${rect.left}px`,
		});

		// Close on click outside the picker
		this.pickerCloseHandler = (e: MouseEvent): void => {
			const target = e.target as Node | null;
			if (!target) return;
			const inside = picker.contains(target) || (this.modelSelectorBtn?.contains(target) ?? false);
			if (!inside) this.closePicker();
		};
		window.setTimeout(() => {
			if (this.pickerCloseHandler) {
				doc.addEventListener("mousedown", this.pickerCloseHandler);
			}
		}, 0);
	}

	// ── Sessions ────────────────────────────────────────────────────────────────

	loadSession(session: { title: string; messages: ChatMessage[]; model?: string }): void {
		this.messages  = [...session.messages];
		this.lastUsage = null;
		this.chatContainer.empty();

		if (!this.messages.length) { this.renderWelcome(); return; }
		for (const msg of this.messages) this.appendMessage(msg.role, msg.content);

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
			const systemMsg  = await this.buildSystemMessage(userText);
			const ragSources = this.lastRagSources;

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

			if (contentEl) {
				const isQuiz = this.learnMode && this.tryRenderQuiz(reply, contentEl);
				if (!isQuiz) this.renderContent(contentEl, reply);
			}
			bubble.dataset.raw = reply;

			// The provider answered with another model (refusal fallback) — say so.
			if (result.servedBy) {
				bubble.createDiv({ cls: "gpt-msg-served-by", text: t("chat_served_by", result.servedBy) });
			}

			// RAG sources
			if (ragSources.length) {
				const srcEl = bubble.parentElement!.createEl("div", { cls: "gpt-rag-sources" });
				srcEl.createEl("span", { cls: "gpt-rag-src-icon",  text: "🗄️" });
				srcEl.createEl("span", { cls: "gpt-rag-src-label", text: t("rag_sources_label") });
				for (const source of ragSources) {
					const chip = srcEl.createEl("button", {
						cls:  "gpt-rag-src-chip",
						text: source.label,
						attr: { type: "button", title: t(source.chunk ? "rag_source_open_at" : "rag_source_open") },
					});
					chip.onclick = () => void this.openSource(source);
				}
			}

			this.messages.push({ role: "assistant", content: reply });

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
					contentEl.createEl("div", { cls: "gpt-msg-error-line", text: `❌ ${t("err_stream")}: ${error.message}` });
					contentEl.createEl("div", { cls: "gpt-msg-error-detail", text: t("err_detail", activeModel, this.currentMode ?? "") });
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

	private lastRagSources: SourceRef[] = [];

	/**
	 * Opens the note behind a source. For a search result it goes to the fragment
	 * the model was given and selects it. Everything happens on the device.
	 */
	private async openSource(source: SourceRef): Promise<void> {
		const { vault, workspace } = this.plugin.app;
		const file = vault.getAbstractFileByPath(source.path);
		if (!(file instanceof TFile)) {
			new Notice(t("rag_source_missing", source.label));
			return;
		}

		let range = null;
		if (source.chunk && file.extension === "md") {
			try {
				range = locateChunk(await vault.cachedRead(file), source.chunk);
			} catch (e) {
				console.warn("[AI-Vault] could not read source note:", (e as Error)?.message);
			}
		}

		const leaf = workspace.getLeaf(false);
		await leaf.openFile(file, range ? { eState: { line: range.line } } : undefined);

		if (range && leaf.view instanceof MarkdownView) {
			const editor = leaf.view.editor;
			const from   = editor.offsetToPos(range.start);
			const to     = editor.offsetToPos(range.end);
			editor.setSelection(from, to);
			editor.scrollIntoView({ from, to }, true);
		} else if (source.chunk && file.extension === "md") {
			new Notice(t("rag_source_moved"));
		}
	}

	private async buildSystemMessage(userText: string): Promise<string> {
		const projId     = this.plugin.activeProjectId;
		const activeProj = projId ? this.plugin.projects.getProject(projId) : null;
		let sys = activeProj?.systemPrompt || this.settings.systemPrompt;

		// Code mode
		if (this.codeMode) {
			sys = t("code_system_prompt_intro") +
				t("code_rules_header") +
				t("code_rule_clean") +
				t("code_rule_1") + t("code_rule_2") + t("code_rule_3") +
				t("code_rule_4") +
				t("code_rule_format") +
				t("code_rule_flag") +
				t("code_rule_5") + t("code_system_prompt_closing");
		}

		if (this.learnMode) sys += t("quiz_instruction");

		const ragSources: SourceRef[] = [];

		// Notes excluded from RAG. Manually attached notes are an explicit user choice and
		// stay allowed; everything reached implicitly — wikilinks and RAG hits — is filtered.
		const ragIgnored = (path: string): boolean => this.rag.isIgnoredPath(path);

		// Manually selected notes
		if (this.manualNotes.length) {
			const allNotes: { file: TFile; content: string }[] = [];
			const visited = new Set<string>();
			for (const f of this.manualNotes) {
				if (f.extension === "canvas") {
					try {
						const raw = await this.plugin.app.vault.cachedRead(f);
						allNotes.push({ file: f, content: parseCanvasToText(raw, f.basename) });
					} catch (e) { console.warn("[AI-Vault] canvas read failed:", f.path, (e as Error)?.message); }
				} else {
					const resolved = await resolveNoteWithLinks(this.plugin.app, f, 1, visited, ragIgnored);
					allNotes.push(...resolved);
				}
			}
			if (allNotes.length) {
				const ctx = allNotes.map(({ file, content }) => `### ${file.basename}\n${content.slice(0, 3000)}`);
				sys += `\n\n---\n${t("rag_manual_ctx_header")}\n\n${ctx.join("\n\n---\n\n")}\n---`;
				ragSources.push(...this.manualNotes.map(f => ({ label: f.basename, path: f.path })));
				const linked = allNotes.filter(n => !this.manualNotes.some(f => f.path === n.file.path));
				ragSources.push(...linked.map(n => ({ label: `↳ ${n.file.basename}`, path: n.file.path })));
			}
		}

		// Auto-RAG
		if (this.settings.ragEnabled && this.rag.indexed && userText) {
			const results  = await this.rag.search(userText, RAG_TOP_K);
			// The engine already filters, but this is the last point before the text
			// leaves the device — and it also keeps the source chips below in sync.
			const filtered = results.filter(r =>
				!this.manualNotes.some(f => f.path === r.path) && !ragIgnored(r.path));
			if (filtered.length) {
				const ctx = filtered.map(r => `### ${r.basename}\n${r.chunk}`).join("\n\n---\n\n");
				sys += `\n\n---\nVAULT CONTEXT (RAG):\n\n${ctx}\n---`;
				ragSources.push(...filtered.map(r => ({ label: r.basename, path: r.path, chunk: r.chunk })));
			}
		}

		// Project context
		if (projId && this.plugin.currentSessionId) {
			const projCtx = await this.plugin.projects.buildProjectContext(projId, this.plugin.currentSessionId);
			if (projCtx) {
				sys += `\n\n---\n${t("rag_project_ctx_header", activeProj?.name ?? "Project")}\n\n${projCtx}\n---`;
			}
		}

		if (sys.length > MAX_SYSTEM_CHARS) {
			sys = sys.slice(0, MAX_SYSTEM_CHARS) + "\n\n" + t("rag_ctx_truncated");
		}

		this.lastRagSources = ragSources;
		return sys;
	}

	// ── UI helpers ──────────────────────────────────────────────────────────────

	renderWelcome(): void {
		const w = this.chatContainer.createEl("div", { cls: "gpt-welcome" });
		w.createEl("div", { cls: "gpt-welcome-icon", text: "✦" });
		w.createEl("p", { text: t("chat_welcome_rag") });
		w.createEl("p", { cls: "gpt-welcome-hint", text: t("chat_welcome_hint") });
	}

	appendMessage(role: string, content: string): HTMLElement {
		this.chatContainer.querySelector(".gpt-welcome")?.remove();
		const msgEl  = this.chatContainer.createEl("div", { cls: `gpt-msg gpt-msg-${role}` });
		const bubble = msgEl.createEl("div", { cls: "gpt-bubble" });
		const contentEl = bubble.createEl("div", { cls: "gpt-msg-content" });

		if (content) {
			const isQuiz = role === "assistant" && this.learnMode && this.tryRenderQuiz(content, contentEl);
			if (!isQuiz) this.renderContent(contentEl, content);
		}

		// Footer with copy button
		const footer     = msgEl.createEl("div", { cls: "gpt-msg-footer" });
		const assistLabel = this.getProviderLabel(this.getEffectiveProvider());
		footer.createEl("span", { cls: "gpt-msg-label", text: role === "user" ? t("chat_role_you") : assistLabel });

		const copyBtn = footer.createEl("button", { cls: "gpt-copy-btn", attr: { title: t("chat_copy"), "aria-label": t("chat_copy") } });
		this.setButtonIcon(copyBtn, "copy");
		copyBtn.onclick = () => {
			void navigator.clipboard.writeText(bubble.dataset.raw ?? contentEl.innerText)
				.then(() => {
					this.setButtonIcon(copyBtn, "check");
					window.setTimeout(() => { this.setButtonIcon(copyBtn, "copy"); }, 2000);
				})
				.catch(error => console.error("[AI-Vault] Copy failed:", error));
		};

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
			const dots = bubble.createEl("div", { cls: "gpt-dots" });
			dots.createEl("span"); dots.createEl("span"); dots.createEl("span");
			if (webSearch) {
				const ind = bubble.createEl("div", { cls: "gpt-websearch-indicator" });
				setIcon(ind, "globe");
				ind.createEl("span", { text: t("ws_searching_label") });
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
		const provName  = this.getProviderLabel(this.getEffectiveProvider());
		const title     = this.plugin.currentSession?.title ?? t("projects_chat_fallback");
		const date      = formatDate(Date.now());
		let md          = t("export_header", title, this.getCurrentActiveModel() || provName, date);
		for (const msg of this.messages) {
			const label = msg.role === "user" ? t("export_user") : `**${provName}:**`;
			md += `${label}\n\n${msg.content}\n\n---\n\n`;
		}
		const safeName = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
		const base     = `AI-Vault/${safeName} ${new Date().toISOString().slice(0, 10)}`;
		if (!this.plugin.app.vault.getAbstractFileByPath("AI-Vault")) {
			try { await this.plugin.app.vault.createFolder("AI-Vault"); } catch { /* already exists */ }
		}
		let fileName = `${base}.md`;
		let counter  = 1;
		while (this.plugin.app.vault.getAbstractFileByPath(fileName)) {
			fileName = `${base} (${counter++}).md`;
		}
		try {
			await this.plugin.app.vault.create(fileName, md);
			new Notice(t("notice_export_done", fileName));
		} catch (e) {
			new Notice(t("notice_export_fail", (e as Error).message));
		}
	}

	// ── Markdown rendering ───────────────────────────────────────────────────────

	/** Final render — native Obsidian renderer */
	private renderContent(el: HTMLElement, text: string): void {
		el.empty();
		void this.renderMarkdown(el, text);
	}

	private async renderMarkdown(el: HTMLElement, text: string): Promise<void> {
		try {
			await MarkdownRenderer.render(this.plugin.app, text, el, "", this.renderComponent);
		} catch (e) {
			console.warn("[AI-Vault] native renderer failed, using fallback:", (e as Error)?.message);
			this.renderPlainTextContent(el, text);
		}
		// Rendering is asynchronous — the code blocks only exist now.
		this.addCodeCopyButtons(el);
	}

	private renderPlainTextContent(el: HTMLElement, text: string): void {
		el.empty();
		const lines = text.split("\n");
		lines.forEach((line, idx) => {
			if (idx > 0) el.createEl("br");
			if (line) el.appendChild(el.ownerDocument.createTextNode(line));
		});
	}

	/** Adds a copy button to each code block that Obsidian has not given one already. */
	private addCodeCopyButtons(container: HTMLElement): void {
		container.querySelectorAll<HTMLElement>("pre > code").forEach(code => {
			const pre = code.parentElement;
			if (!pre || pre.querySelector(".copy-code-button, .gpt-code-copy")) return;

			pre.addClass("gpt-code-block");
			const copyBtn = pre.createEl("button", {
				cls:  "gpt-code-copy",
				attr: { title: t("chat_copy_code"), "aria-label": t("chat_copy_code") },
			});
			this.setButtonIcon(copyBtn, "copy");
			copyBtn.onclick = async () => {
				try {
					await navigator.clipboard.writeText(code.textContent ?? "");
					this.setButtonIcon(copyBtn, "check");
					copyBtn.addClass("gpt-code-copy--ok");
					window.setTimeout(() => {
						this.setButtonIcon(copyBtn, "copy");
						copyBtn.removeClass("gpt-code-copy--ok");
					}, 2000);
				} catch (e) {
					console.warn("[AI-Vault] copy failed:", (e as Error)?.message);
				}
			};
		});
	}

	// ── Quiz renderer ────────────────────────────────────────────────────────────

	private tryRenderQuiz(content: string, container: HTMLElement): boolean {
		interface QuizData { title?: string; questions: QuizQuestion[] }
		let quiz: QuizData | null = null;

		const mdMatch = content.match(/```json\s*([\s\S]*?)```/);
		if (mdMatch) { try { quiz = JSON.parse(mdMatch[1]) as QuizData; } catch { /* ignore */ } }

		if (!quiz) {
			const match = content.match(/\{[\s\S]*"questions"[\s\S]*\}/);
			if (match) { try { quiz = JSON.parse(match[0]) as QuizData; } catch { /* ignore */ } }
		}
		if (!quiz) {
			try {
				const parsed = JSON.parse(content.trim()) as QuizData;
				if (parsed?.questions) quiz = parsed;
			} catch { /* ignore */ }
		}

		if (!quiz || !Array.isArray(quiz.questions)) return false;

		const doc = container.ownerDocument;
		container.empty();
		if (quiz.title) container.createEl("div", { cls: "gpt-quiz-title", text: quiz.title });

		const questionCount = quiz.questions.length;
		quiz.questions.forEach((q, qi) => {
			this.normalizeQuestion(q);
			const card = container.createEl("div", { cls: "gpt-quiz-card" });
			card.createEl("div", { cls: "gpt-quiz-qnum",  text: t("quiz_progress", qi + 1, questionCount) });
			card.createEl("div", { cls: "gpt-quiz-qtext", text: q.question || t("quiz_no_question") });

			let answered = false;

			if ((q.type === "choice" || q.type === "truefalse") && q.options?.length) {
				const opts = card.createEl("div", { cls: "gpt-quiz-opts" });
				q.options.forEach((opt, oi) => {
					const btn    = opts.createEl("button", { cls: "gpt-quiz-opt" });
					const prefix = q.type === "truefalse" ? "" : String.fromCharCode(65 + oi) + ". ";
					btn.textContent = prefix + opt;
					btn.onclick = () => {
						if (answered) return;
						answered = true;
						const correct = oi === q.correct;
						opts.querySelectorAll<HTMLButtonElement>(".gpt-quiz-opt").forEach((b, bi) => {
							b.disabled = true;
							if (bi === q.correct) b.classList.add("gpt-quiz-opt--correct");
							else if (bi === oi && !correct) b.classList.add("gpt-quiz-opt--wrong");
						});
						const fb = card.createEl("div", {
							cls: correct ? "gpt-quiz-fb gpt-quiz-fb--ok" : "gpt-quiz-fb gpt-quiz-fb--err",
						});
						if (correct) {
							fb.textContent = t("quiz_correct") + " ";
							if (q.explanation) fb.appendChild(doc.createTextNode(q.explanation));
						} else {
							const corrPrefix = q.type === "truefalse" ? "" : String.fromCharCode(65 + (q.correct ?? 0)) + ". ";
							fb.appendChild(doc.createTextNode(t("quiz_wrong_prefix")));
							fb.createEl("strong", { text: corrPrefix + (q.options?.[q.correct ?? 0] ?? "") });
							if (q.explanation) { fb.createEl("br"); fb.appendChild(doc.createTextNode(q.explanation)); }
						}
					};
				});
			} else if (q.type === "open" || q.type === "fill") {
				const inp = card.createEl("textarea", {
					cls:  "gpt-quiz-input",
					attr: { placeholder: q.type === "fill" ? t("quiz_fill_placeholder") : t("quiz_open_placeholder"), rows: "2" },
				});
				const checkBtn = card.createEl("button", { cls: "gpt-quiz-check", text: t("quiz_check_btn") });
				checkBtn.onclick = async () => {
					if (answered) return;
					const ans = inp.value.trim();
					if (!ans) return;
					answered = true; inp.disabled = true; checkBtn.disabled = true;
					checkBtn.textContent = t("quiz_checking");

					if (q.type === "fill") {
						const ok = ans.toLowerCase() === String(q.answer ?? "").toLowerCase().trim();
						const fb = card.createEl("div", { cls: ok ? "gpt-quiz-fb gpt-quiz-fb--ok" : "gpt-quiz-fb gpt-quiz-fb--err" });
						if (ok) { fb.textContent = t("quiz_correct"); }
						else { fb.appendChild(doc.createTextNode(t("quiz_correct_prefix"))); fb.createEl("strong", { text: String(q.answer ?? "") }); }
					} else {
						try {
							const prompt = t("quiz_eval_prompt", q.question, q.answer, ans);
							const activeModel = this.getCurrentActiveModel();
							const provider = this.getEffectiveProvider();
							let r: StreamResult;
							if (provider === "anthropic") {
								r = await callClaude(this.settings.claudeApiKey, activeModel, [{ role: "user", content: prompt }], "fast");
							} else if (provider === "local") {
								if (!(await this.confirmPlainHttpEndpoint())) throw new Error("declined");
								const text = await callLocalApi(
									this.settings,
									[{ role: "user", content: prompt }],
									{ maxTokens: this.getMaxTokensForMode("fast") },
								);
								r = { text, usage: null };
							} else {
								r = await callOpenAI(this.settings.apiKey, activeModel, [{ role: "user", content: prompt }], "fast");
							}
							const ev = JSON.parse(r.text.replace(/```json|```/g, "").trim()) as { correct: boolean; feedback: string };
							card.createEl("div", { cls: ev.correct ? "gpt-quiz-fb gpt-quiz-fb--ok" : "gpt-quiz-fb gpt-quiz-fb--err", text: (ev.correct ? "✅ " : "❌ ") + (ev.feedback ?? "") });
						} catch { card.createEl("div", { cls: "gpt-quiz-fb gpt-quiz-fb--err", text: t("quiz_eval_error") }); }
					}
					checkBtn.textContent = t("quiz_check_btn");
				};
			}
		});
		return true;
	}

	private normalizeQuestion(q: QuizQuestion): void {
		if (!q.question) q.question = this.stringValue(q["text"] ?? q["prompt"] ?? q["content"]);
		if (!q.type) {
			if (q.options?.length === 2 && q.options.every(o => /^(true|false|yes|no)$/i.test(o))) q.type = "truefalse";
			else if (q.options?.length) q.type = "choice";
			else if (q.answer) q.type = "open";
			else q.type = "choice";
		}
		const aliases: Record<string, string> = {
			multiple_choice: "choice", single_choice: "choice", mcq: "choice",
			true_false: "truefalse", boolean: "truefalse", tf: "truefalse",
			short_answer: "open", free_text: "open", fill_blank: "fill", gap: "fill",
		};
		if (aliases[q.type]) q.type = aliases[q.type];
		if (q.type === "truefalse" && !q.options?.length) q.options = [t("quiz_true_option"), t("quiz_false_option")];
		if (!q.options && Array.isArray(q["answers"])) q.options = q["answers"] as string[];
		if (!q.options && Array.isArray(q["choices"])) q.options = q["choices"] as string[];

		const ca = q["correct_answer"] ?? q["correctAnswer"];
		if (q.correct === undefined && ca !== undefined) {
			if (typeof ca === "number") q.correct = ca;
			else if (typeof ca === "boolean") q.correct = ca ? 0 : 1;
			else if (typeof ca === "string" && q.options) {
				let idx = q.options.findIndex(o => o === ca);
				if (idx < 0) idx = q.options.findIndex(o => o.toLowerCase() === ca.toLowerCase());
				if (idx < 0 && /^[A-D]$/i.test(ca)) idx = ca.toUpperCase().charCodeAt(0) - 65;
				if (idx >= 0) q.correct = idx;
			}
		}
		if ((q.type === "choice" || q.type === "truefalse") && q.correct === undefined) q.correct = 0;
		if (!q.answer && (q.type === "open" || q.type === "fill")) {
			q.answer = this.stringValue(ca ?? q["expected_answer"]);
		}
	}

	private stringValue(value: unknown): string {
		return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
			? String(value)
			: "";
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
