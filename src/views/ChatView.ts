import {
	Component,
	ItemView,
	MarkdownRenderer,
	Notice,
	setIcon,
	WorkspaceLeaf,
} from "obsidian";
import type { TFile } from "obsidian";

import { CHAT_VIEW_TYPE, RAG_TOP_K } from "../constants";
import { t } from "../i18n";
import {
	THINKING_MODES,
	WEB_SEARCH_CAPABLE,
	ModelAccessError,
	detectProvider,
	isGPT5,
	isGPT5Search,
} from "../models";
import {
	formatDate,
	base64ToUtf8,
} from "../utils";
import { callOpenAI }  from "../api/openai";
import { callClaude }  from "../api/anthropic";
import { callLocalApi } from "../api/local";
import { parseCanvasToText }   from "../rag/canvasParser";
import { resolveNoteWithLinks } from "../rag/linkResolver";
import { FallbackModal } from "./FallbackModal";
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

const RENDER_INTERVAL_MS = 80;
const MAX_SYSTEM_CHARS   = 120_000;

interface ModelOption {
	id:    string;
	label: string;
	desc:  () => string;
}

interface ProviderOption {
	id:    Provider;
	label: string;
	icon:  string;
	desc:  () => string;
}

const PROVIDER_OPTIONS: ProviderOption[] = [
	{ id: "openai",    label: "GPT",    icon: "🤖", desc: () => t("chat_provider_gpt_desc")    },
	{ id: "anthropic", label: "Claude", icon: "🟣", desc: () => t("chat_provider_claude_desc") },
	{ id: "local",     label: "Local API", icon: "🖥️", desc: () => t("chat_provider_ollama_desc") },
];

const ALL_MODELS: Record<"openai" | "anthropic", ModelOption[]> = {
	openai: [
		{ id: "gpt-5",            label: "GPT-5",        desc: () => t("model_desc_gpt5")       },
		{ id: "gpt-5-mini",       label: "GPT-5 Mini",   desc: () => t("model_desc_gpt5mini")   },
		{ id: "gpt-5-nano",       label: "GPT-5 Nano",   desc: () => t("model_desc_gpt5nano")   },
		{ id: "gpt-5-search-api", label: "GPT-5 Search", desc: () => t("model_desc_gpt5search") },
		{ id: "gpt-4o",           label: "GPT-4o",       desc: () => t("model_desc_gpt4o")      },
		{ id: "gpt-4o-mini",      label: "GPT-4o Mini",  desc: () => t("model_desc_gpt4omini")  },
		{ id: "gpt-4-turbo",      label: "GPT-4 Turbo",  desc: () => t("model_desc_gpt4turbo")  },
	],
	anthropic: [
		{ id: "claude-opus-4-5",   label: "Opus 4.5",   desc: () => t("model_desc_opus")   },
		{ id: "claude-sonnet-4-5", label: "Sonnet 4.5", desc: () => t("model_desc_sonnet") },
		{ id: "claude-haiku-4-5",  label: "Haiku 4.5",  desc: () => t("model_desc_haiku")  },
	],
};

// ─── GPTChatView ───────────────────────────────────────────────────────────────

export class GPTChatView extends ItemView {
	// State
	messages:        ChatMessage[] = [];
	webSearchActive  = false;
	learnMode        = false;
	codeMode         = false;
	manualNotes:     TFile[] = [];
	currentMode:     string | null = null;
	abortController: AbortController | null = null;

	// Reference to the open model picker and its global mousedown handler
	private currentPicker:       HTMLElement | null = null;
	private currentPickerKind:   "model" | "provider" | null = null;
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
	private ragBadge!:         HTMLElement;
	private ragToggleBtn!:     HTMLButtonElement;
	private webSearchBtn!:     HTMLButtonElement;
	private learnBtn!:         HTMLButtonElement;
	private codeBtn!:          HTMLButtonElement;
	private providerSelectorBtn!: HTMLButtonElement;
	private modelSelectorBtn!: HTMLButtonElement;
	private projectBar!:       HTMLElement;
	private projectBarLabel!:  HTMLElement;
	private manualBar!:        HTMLElement;
	private manualBarList!:    HTMLElement;
	private modeLabel!:        HTMLElement;
	private modeButtons:       Record<string, HTMLButtonElement> = {};

	constructor(leaf: WorkspaceLeaf, private readonly plugin: PluginWithDeps) {
		super(leaf);
		this.renderComponent = new Component();
		this.addChild(this.renderComponent);
	}

	private get settings(): PluginSettings { return this.plugin.settings; }
	private get rag():      RAGEngine      { return this.plugin.rag; }

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
		this.currentPickerKind = null;
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
		this.showRagStatus("⏳ Indexing vault…", "indexing");
		await this.rag.buildIndex((done, total) => {
			if (this.ragStatusEl) this.ragStatusEl.textContent = `⏳ Indexing… ${done}/${total}`;
		});
		const s = this.rag.stats;
		this.showRagStatus(t("rag_ready_full", s.files, s.embeddings), "ready");
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
		this.buildModeBar(root);
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
		const header = root.createEl("div", { cls: "gpt-header" });
		header.createEl("span", { cls: "gpt-header-icon", text: "✦" });

		this.providerSelectorBtn = header.createEl("button", { cls: "gpt-provider-selector" });
		this.providerSelectorBtn.onclick = () => this.openProviderPicker();

		this.modelSelectorBtn = header.createEl("button", { cls: "gpt-model-selector" });
		this.modelSelectorBtn.onclick = () => this.openModelPicker();

		this.ragBadge = header.createEl("span", { cls: "gpt-rag-badge" });
		this.updateRagBadge();

		this.updateProviderSwitch();

		const histBtn = header.createEl("button", { cls: "gpt-icon-btn", attr: { "aria-label": t("cmd_open_history") } });
		this.setButtonIcon(histBtn, "history");
		histBtn.onclick   = () => void this.plugin.activateHistoryView();

		const projBtn = header.createEl("button", { cls: "gpt-icon-btn", attr: { "aria-label": t("chat_projects") } });
		this.setButtonIcon(projBtn, "folder");
		projBtn.onclick   = () => void this.plugin.activateProjectsView();

		const clearBtn = header.createEl("button", { cls: "gpt-clear-btn", text: t("chat_new") });
		clearBtn.onclick = () => this.plugin.newChat();
	}

	private buildModeBar(root: HTMLElement): void {
		const bar = root.createEl("div", { cls: "gpt-mode-bar" });
		for (const [key, m] of Object.entries(THINKING_MODES)) {
			const btn = bar.createEl("button", {
				cls:  "gpt-mode-btn",
				text: m.label,
				attr: { title: m.desc },
			});
			btn.onclick = () => this.setMode(key);
			this.modeButtons[key] = btn;
		}
		this.setMode(this.settings.thinkingMode, true);
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
		const area    = root.createEl("div", { cls: "gpt-input-area" });
		const toolRow = area.createEl("div", { cls: "gpt-tool-row" });

		// RAG toggle
		this.ragToggleBtn = toolRow.createEl("button", {
			cls:  "gpt-tool-btn" + (this.settings.ragEnabled ? " gpt-rag-btn--active" : ""),
			attr: { title: t("chat_title_rag") },
		});
		this.setButtonIcon(this.ragToggleBtn, "database", t("chat_btn_rag"));
		this.ragToggleBtn.onclick   = () => this.toggleRag();

		// Re-index
		const reindexBtn = toolRow.createEl("button", { cls: "gpt-tool-btn", attr: { title: t("chat_title_index") } });
		this.setButtonIcon(reindexBtn, "refresh-cw", t("chat_btn_index"));
		reindexBtn.onclick   = async () => { reindexBtn.disabled = true; await this.startIndexing(); reindexBtn.disabled = false; };

		// Note picker
		const pickBtn = toolRow.createEl("button", { cls: "gpt-tool-btn", attr: { title: t("chat_title_notes") } });
		this.setButtonIcon(pickBtn, "paperclip", t("chat_btn_notes"));
		pickBtn.onclick   = () => this.openNotePicker();

		// Web search
		this.webSearchBtn = toolRow.createEl("button", { cls: "gpt-tool-btn", attr: { title: t("chat_title_internet") } });
		this.setButtonIcon(this.webSearchBtn, "globe", t("chat_btn_internet"));
		this.webSearchBtn.onclick   = () => this.toggleWebSearch();

		// Learn mode
		this.learnBtn = toolRow.createEl("button", { cls: "gpt-tool-btn", attr: { title: t("chat_title_learn") } });
		this.setButtonIcon(this.learnBtn, "book-open", t("chat_btn_learn"));
		this.learnBtn.onclick   = () => this.toggleLearnMode();

		// Code mode
		this.codeBtn = toolRow.createEl("button", { cls: "gpt-tool-btn", attr: { title: t("chat_title_code") } });
		this.setButtonIcon(this.codeBtn, "code", t("chat_btn_code"));
		this.codeBtn.onclick   = () => this.toggleCodeMode();

		// Textarea
		this.inputEl = area.createEl("textarea", {
			cls:  "gpt-input",
			attr: { placeholder: t("chat_placeholder"), rows: "3" },
		});
		// registerDomEvent instead of addEventListener — lets Obsidian know this element handles the keyboard
		// prevents Obsidian's global handler from intercepting Enter/shortcuts
		this.registerDomEvent(this.inputEl, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void this.sendMessage(); }
		});

		// Button row
		const btnRow = area.createEl("div", { cls: "gpt-btn-row" });
		this.modeLabel = btnRow.createEl("span", { cls: "gpt-mode-label" });
		this.updateModeLabel();

		const regenBtn = btnRow.createEl("button", { cls: "gpt-action-btn", attr: { title: t("chat_regen_tooltip") } });
		this.setButtonIcon(regenBtn, "refresh-cw");
		regenBtn.onclick   = () => void this.regenerateLastMessage();

		const exportBtn = btnRow.createEl("button", { cls: "gpt-action-btn", attr: { title: t("chat_export_tooltip") } });
		this.setButtonIcon(exportBtn, "file-up");
		exportBtn.onclick   = () => void this.exportToNote();

		this.sendBtn = btnRow.createEl("button", { cls: "gpt-send-btn", text: t("chat_send") });
		this.sendBtn.onclick = () => void this.sendMessage();
	}

	// ── Note picker ─────────────────────────────────────────────────────────────

	private openNotePicker(): void {
		// The picker intentionally lists eligible vault files after explicit user action.
		const files = this.plugin.app.vault.getFiles()
			.filter((file: TFile) => file.extension === "md" || file.extension === "canvas")
			.sort((a, b) => a.basename.localeCompare(b.basename));
		const doc         = this.containerEl.ownerDocument;

		const overlay = doc.createElement("div");
		overlay.className = "gpt-modal-overlay";
		const box = doc.createElement("div");
		box.className = "gpt-modal-box";

		box.createEl("p", { cls: "gpt-modal-title", text: t("chat_notes_title") });

		const searchInput = box.createEl("input", {
			cls:  "gpt-modal-input",
			attr: { type: "text", placeholder: t("chat_notes_search") },
		});

		const list     = box.createEl("div", { cls: "gpt-modal-list" });
		const selected = new Set(this.manualNotes.map(f => f.path));

		const renderList = (filter = ""): void => {
			list.empty();
			const filtered = files.filter(f => f.basename.toLowerCase().includes(filter.toLowerCase()));
			for (const f of filtered.slice(0, 50)) {
				const row = list.createEl("label", { cls: "gpt-modal-row" });
				const cb  = row.createEl("input", { cls: "gpt-modal-checkbox", attr: { type: "checkbox" } });
				cb.checked        = selected.has(f.path);
				cb.onchange = () => {
					if (selected.has(f.path)) selected.delete(f.path);
					else selected.add(f.path);
				};
				const icon = f.extension === "canvas" ? "🗂️ " : "";
				row.createEl("span", { cls: "gpt-modal-row-label", text: icon + f.basename });
			}
			if (filtered.length > 50) {
				list.createEl("div", {
					cls:  "gpt-modal-more",
					text: t("chat_notes_more", filtered.length - 50),
				});
			}
		};
		renderList();
		searchInput.oninput = () => renderList(searchInput.value);

		const btns   = box.createEl("div", { cls: "gpt-modal-btns" });
		const cancel = btns.createEl("button", { cls: "gpt-modal-cancel", text: t("chat_notes_cancel") });
		cancel.onclick = () => overlay.remove();

		const ok = btns.createEl("button", { cls: "gpt-modal-ok", text: t("chat_notes_add") });
		ok.onclick = () => {
			this.manualNotes = files.filter(f => selected.has(f.path));
			this.updateManualBar();
			overlay.remove();
			if (this.manualNotes.length) new Notice(t("chat_notes_added", this.manualNotes.length));
		};

		overlay.appendChild(box);
		this.containerEl.appendChild(overlay);
		window.setTimeout(() => searchInput.focus(), 50);
	}

	updateManualBar(): void {
		if (!this.manualBar) return;
		if (!this.manualNotes.length) {
			this.manualBar.addClass("gpt-ctx-hidden");
			this.manualBarList.textContent = "";
			return;
		}
		this.manualBar.removeClass("gpt-ctx-hidden");
		this.manualBarList.textContent = "📎 " + this.manualNotes.map(f => f.basename).join(", ");
	}

	// ── Controls ────────────────────────────────────────────────────────────────

	toggleRag(): void {
		this.settings.ragEnabled = !this.settings.ragEnabled;
		void this.plugin.saveSettings();
		this.ragToggleBtn.classList.toggle("gpt-rag-btn--active", this.settings.ragEnabled);
		this.updateRagBadge();
		new Notice(this.settings.ragEnabled ? t("rag_on_notice") : t("rag_off_notice"));
	}

	updateRagBadge(): void {
		if (!this.ragBadge) return;
		this.ragBadge.textContent   = this.settings.ragEnabled ? "RAG" : "";
		if (this.settings.ragEnabled) {
			this.ragBadge.removeClass("gpt-ctx-hidden");
		} else {
			this.ragBadge.addClass("gpt-ctx-hidden");
		}
	}

	updateProjectBar(): void {
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

	setMode(key: string, silent = false): void {
		this.currentMode = key;
		for (const [k, btn] of Object.entries(this.modeButtons)) {
			btn.classList.toggle("gpt-mode-btn--active", k === key);
		}
		if (!silent) this.updateModeLabel();
	}

	private updateModeLabel(): void {
		if (!this.modeLabel) return;
		const m = THINKING_MODES[this.currentMode ?? ""];
		this.modeLabel.textContent = m ? `${m.label} · ${m.desc}` : "";
	}

	private getCurrentActiveModel(): string {
		const provider = this.settings.provider;
		if (provider === "anthropic") return this.settings.claudeModel ?? "claude-sonnet-4-5";
		if (provider === "local") return this.settings.localModel?.trim() ?? "";
		return this.settings.model ?? "gpt-4o";
	}

	private getEffectiveProvider(model = this.getCurrentActiveModel()): Provider {
		if (!this.settings.autoDetectProvider) return this.settings.provider;
		const detected = detectProvider(model);
		return detected === this.settings.provider ? detected : this.settings.provider;
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

	private getProviderOption(provider: Provider): ProviderOption {
		return PROVIDER_OPTIONS.find(option => option.id === provider) ?? PROVIDER_OPTIONS[0];
	}

	private getProviderPlaceholder(provider: Provider): string {
		if (provider === "anthropic") return t("chat_placeholder_claude");
		if (provider === "local") return t("chat_placeholder_ollama");
		return t("chat_placeholder");
	}

	private formatModelLabel(model: string, provider: Provider): string {
		const known = this.getModelsForProvider(provider).find(option => option.id === model);
		if (known) return known.label;

		if (provider === "openai") {
			return model
				.replace("gpt-", "GPT-")
				.replace("-search-api", " Search");
		}
		if (provider === "anthropic") {
			return model
				.replace("claude-", "")
				.replace(/-4-[56]/g, "");
		}
		return model;
	}

	private getLocalModelsForPicker(): ModelOption[] {
		const models  = [...(this.settings.localModelsCache ?? [])];
		const current = this.settings.localModel?.trim();
		if (current && !models.includes(current)) models.unshift(current);
		return models.map(model => ({ id: model, label: model, desc: () => t("model_desc_ollama") }));
	}

	private getModelsForProvider(provider: Provider): ModelOption[] {
		if (provider === "openai") return [...ALL_MODELS.openai];
		if (provider === "anthropic") return [...ALL_MODELS.anthropic];
		return this.getLocalModelsForPicker();
	}

	private getModelPickerGroups(): Array<{ provider: Provider; title: string; models: ModelOption[] }> {
		const provider = this.settings.provider;
		const group = {
			provider,
			title: this.getModelPickerTitle(provider),
			models: this.getModelsForProvider(provider),
		};
		const activeModel = this.getCurrentActiveModel();
		const known = group.models.some(model => model.id === activeModel);
		if (!known) {
			group.models.unshift({ id: activeModel, label: activeModel, desc: () => t("model_desc_custom") });
		}

		return [group];
	}

	private getModelPickerTitle(provider: Provider): string {
		if (provider === "anthropic") return t("chat_picker_claude");
		if (provider === "local") return t("chat_picker_ollama");
		return t("chat_picker_openai");
	}

	private setActiveModel(model: string): Provider {
		const provider = this.settings.provider;
		this.settings.provider = provider;
		if (provider === "openai") {
			this.settings.model = model;
		} else if (provider === "anthropic") {
			this.settings.claudeModel = model;
		} else {
			this.settings.localModel = model;
		}
		return provider;
	}

	private disableUnsupportedWebSearch(provider: Provider, model: string): void {
		if (!this.webSearchActive) return;
		const unsupported =
			provider === "local" ||
			(provider === "openai" && !WEB_SEARCH_CAPABLE.has(model));
		if (!unsupported) return;

		this.webSearchActive = false;
		this.webSearchBtn?.classList.remove("gpt-websearch-btn--active");
	}

	toggleWebSearch(): void {
		const activeModel = this.getCurrentActiveModel();
		const provider = this.getEffectiveProvider(activeModel);

		if (!this.webSearchActive && provider === "local") {
			new Notice(t("ws_ollama_unsupported"), 7000);
			return;
		}
		if (
			!this.webSearchActive &&
			provider === "openai" &&
			!WEB_SEARCH_CAPABLE.has(activeModel)
		) {
			new Notice(t("ws_unsupported", activeModel), 7000);
			return;
		}
		this.webSearchActive = !this.webSearchActive;
		this.webSearchBtn.classList.toggle("gpt-websearch-btn--active", this.webSearchActive);

		if (isGPT5Search(activeModel)) {
			new Notice(t("ws_gpt5search_always"), 5000);
		} else if (this.webSearchActive && provider === "anthropic") {
			new Notice(t("ws_claude_enabled", activeModel));
		} else {
			new Notice(this.webSearchActive
				? t("ws_enabled", activeModel)
				: t("ws_disabled"));
		}
	}

	toggleLearnMode(): void {
		this.learnMode = !this.learnMode;
		this.learnBtn.classList.toggle("gpt-learn-btn--active", this.learnMode);
		if (this.learnMode) {
			new Notice(t("mode_learn_on"));
			this.inputEl.placeholder = t("chat_placeholder_learn");
		} else {
			new Notice(t("mode_learn_off"));
			this.inputEl.placeholder = this.getProviderPlaceholder(this.getEffectiveProvider());
		}
	}

	toggleCodeMode(): void {
		this.codeMode = !this.codeMode;
		this.codeBtn.classList.toggle("gpt-code-btn--active", this.codeMode);
		const provName = this.getProviderLabel(this.getEffectiveProvider());
		if (this.codeMode) {
			new Notice(t("mode_code_on", provName));
			this.inputEl.placeholder = t("chat_placeholder_code");
		} else {
			new Notice(t("mode_code_off"));
			this.inputEl.placeholder = this.getProviderPlaceholder(this.getEffectiveProvider());
		}
	}

	setProvider(provider: Provider): void {
		this.closePicker();
		this.settings.provider = provider;
		this.plugin.saveSettings()
			.catch(err => console.error("[AI-Vault] Failed to save provider:", err));
		this.updateProviderSwitch();
		const activeModel = this.getCurrentActiveModel();
		this.disableUnsupportedWebSearch(provider, activeModel);
		const message =
			provider === "openai" ? t("provider_switched_gpt") :
			provider === "anthropic" ? t("provider_switched_claude") :
			t("provider_switched_ollama");
		new Notice(message);
	}

	updateProviderSwitch(): void {
		if (!this.providerSelectorBtn) return;
		const provider = this.settings.provider;
		const option = this.getProviderOption(provider);

		this.providerSelectorBtn.empty();
		this.providerSelectorBtn.classList.toggle("gpt-provider-selector--openai", provider === "openai");
		this.providerSelectorBtn.classList.toggle("gpt-provider-selector--claude", provider === "anthropic");
		this.providerSelectorBtn.classList.toggle("gpt-provider-selector--ollama", provider === "local");
		this.providerSelectorBtn.createEl("span", { cls: "gpt-provider-icon", text: option.icon });
		this.providerSelectorBtn.createEl("span", { cls: "gpt-provider-label", text: option.label });
		const arrow = this.providerSelectorBtn.createEl("span", { cls: "gpt-provider-arrow" });
		setIcon(arrow, "chevron-down");
		this.providerSelectorBtn.title = t("chat_provider_tooltip", option.label);

		if (this.inputEl && !this.codeMode && !this.learnMode) {
			this.inputEl.placeholder = this.getProviderPlaceholder(provider);
		}
		this.updateModelSelector();
	}

	updateModelSelector(): void {
		if (!this.modelSelectorBtn) return;
		const model = this.getCurrentActiveModel();
		const provider = this.settings.provider;
		const icon = this.getProviderIcon(provider);
		const label = this.formatModelLabel(model, provider);

		this.modelSelectorBtn.empty();
		this.modelSelectorBtn.createEl("span", { cls: "gpt-ms-icon", text: icon });
		this.modelSelectorBtn.createEl("span", { cls: "gpt-ms-label", text: label });
		const arrow = this.modelSelectorBtn.createEl("span", { cls: "gpt-ms-arrow" });
		setIcon(arrow, "chevron-down");
		this.modelSelectorBtn.title = t("chat_model_tooltip", model);
	}

	private closePicker(): void {
		if (this.pickerCloseHandler) {
			const doc = this.currentPicker?.ownerDocument ?? this.containerEl.ownerDocument;
			doc.removeEventListener("mousedown", this.pickerCloseHandler);
			this.pickerCloseHandler = null;
		}
		this.currentPicker?.remove();
		this.currentPicker = null;
		this.currentPickerKind = null;
	}

	private openProviderPicker(): void {
		if (this.currentPicker) {
			const wasProviderPicker = this.currentPickerKind === "provider";
			this.closePicker();
			if (wasProviderPicker) return;
		}

		const activeProvider = this.settings.provider;
		const doc = this.containerEl.ownerDocument;
		const picker = doc.createElement("div");
		picker.className = "gpt-model-picker gpt-provider-picker";
		this.currentPicker = picker;
		this.currentPickerKind = "provider";

		const hdr = doc.createElement("div");
		hdr.className = "gpt-mp-header";
		hdr.textContent = t("chat_provider_picker_title");
		picker.appendChild(hdr);

		for (const option of PROVIDER_OPTIONS) {
			const isActive = option.id === activeProvider;
			const row = doc.createElement("button");
			row.className = "gpt-mp-row gpt-provider-row" + (isActive ? " gpt-mp-row--active" : "");
			row.type = "button";

			const icon = doc.createElement("span");
			icon.className = "gpt-provider-row-icon";
			icon.textContent = option.icon;
			row.appendChild(icon);

			const left = doc.createElement("span");
			left.className = "gpt-mp-row-left";

			const name = doc.createElement("span");
			name.className = "gpt-mp-row-name";
			name.textContent = option.label;

			const desc = doc.createElement("span");
			desc.className = "gpt-mp-row-desc";
			desc.textContent = option.desc();

			left.appendChild(name);
			left.appendChild(desc);
			row.appendChild(left);

			if (isActive) {
				const check = doc.createElement("span");
				check.className = "gpt-mp-row-check";
				check.textContent = "✓";
				row.appendChild(check);
			}

			row.addEventListener("mousedown", (e) => e.stopPropagation());
			row.addEventListener("click", () => this.setProvider(option.id));
			picker.appendChild(row);
		}

		doc.body.appendChild(picker);
		const rect = this.providerSelectorBtn.getBoundingClientRect();
		picker.setCssStyles({
			top:  `${rect.bottom + 4}px`,
			left: `${rect.left}px`,
		});

		this.pickerCloseHandler = (e: MouseEvent): void => {
			const target = e.target as Node | null;
			if (!target) return;
			const inside = picker.contains(target) || (this.providerSelectorBtn?.contains(target) ?? false);
			if (!inside) this.closePicker();
		};
		window.setTimeout(() => {
			if (this.pickerCloseHandler) {
				doc.addEventListener("mousedown", this.pickerCloseHandler);
			}
		}, 0);
	}

	private openModelPicker(): void {
		// Toggle: if the picker is already open — close it
		if (this.currentPicker) {
			const wasModelPicker = this.currentPickerKind === "model";
			this.closePicker();
			if (wasModelPicker) return;
		}

		const groups = this.getModelPickerGroups();
		const activeId = this.getCurrentActiveModel();
		const doc = this.containerEl.ownerDocument;

		const picker = doc.createElement("div");
		picker.className = "gpt-model-picker";
		this.currentPicker = picker;
		this.currentPickerKind = "model";

		for (const group of groups) {
			const hdr = doc.createElement("div");
			hdr.className   = "gpt-mp-header";
			hdr.textContent = group.title;
			picker.appendChild(hdr);

			for (const model of group.models) {
				const isActive = model.id === activeId;
				const row = doc.createElement("button");
				row.className = "gpt-mp-row" + (isActive ? " gpt-mp-row--active" : "");
				row.type = "button";

				const left = doc.createElement("span");
				left.className = "gpt-mp-row-left";

				const name = doc.createElement("span");
				name.className   = "gpt-mp-row-name";
				name.textContent = model.label;

				const desc = doc.createElement("span");
				desc.className   = "gpt-mp-row-desc";
				desc.textContent = model.desc();

				left.appendChild(name);
				left.appendChild(desc);
				row.appendChild(left);

				if (isActive) {
					const check = doc.createElement("span");
					check.className   = "gpt-mp-row-check";
					check.textContent = "✓";
					row.appendChild(check);
				}

				row.addEventListener("mousedown", (e) => e.stopPropagation());
				row.addEventListener("click", () => {
					this.closePicker();
					const provider = this.setActiveModel(model.id);
					this.disableUnsupportedWebSearch(provider, model.id);
					this.plugin.saveSettings()
						.then(() => {
							this.updateProviderSwitch();
							new Notice(t("notice_model_changed", model.label), 2000);
						})
						.catch(err => console.error("[AI-Vault] Failed to save selected model:", err));
				});

				picker.appendChild(row);
			}
		}

		// Attach to the view document body — avoids CSS transform issues on Obsidian panels
		doc.body.appendChild(picker);
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
		this.updateModeLabel();
		this.updateModelSelector();
	}

	// ── Send message ─────────────────────────────────────────────────────────────

	async sendMessage(override?: string): Promise<void> {
		const userText = override ?? this.inputEl.value.trim();
		if (!userText) return;

		const activeModel = this.getCurrentActiveModel();
		const activeProvider = this.getEffectiveProvider(activeModel);
		const webSearchEnabled = activeProvider !== "local" && this.webSearchActive;
		if (activeProvider === "openai" && !this.settings.apiKey) { new Notice(t("err_no_openai_key")); return; }
		if (activeProvider === "anthropic" && !this.settings.claudeApiKey) { new Notice(t("err_no_claude_key")); return; }
		if (activeProvider === "local" && !this.settings.localBaseUrl.trim()) { new Notice(t("err_no_ollama_url")); return; }

		if (!override) this.inputEl.value = "";
		this.sendBtn.disabled = true;
		this.messages.push({ role: "user", content: userText });
		this.appendMessage("user", userText);

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

			// Throttled streaming — fast parser during the stream, native renderer at the end
			let streamStarted    = false;
			let lastRenderTime   = 0;

			const onChunk = (partial: string): void => {
				if (!streamStarted) { this.setLoading(bubble, false); streamStarted = true; }
				const now = Date.now();
				if (now - lastRenderTime < RENDER_INTERVAL_MS) return;
				lastRenderTime = now;
				if (contentEl) {
					this.renderPlainTextContent(contentEl, partial, true);
				}
				this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
			};

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
				});
				onChunk(text);
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

			// RAG sources
			if (ragSources.length) {
				const srcEl = bubble.parentElement!.createEl("div", { cls: "gpt-rag-sources" });
				srcEl.createEl("span", { cls: "gpt-rag-src-icon",  text: "🗄️" });
				srcEl.createEl("span", { cls: "gpt-rag-src-label", text: t("rag_sources_label") });
				for (const s of ragSources) srcEl.createEl("span", { cls: "gpt-rag-src-chip", text: s });
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
			const partial   = contentEl?.innerText?.trim() ?? "";

			if (isAbort && partial) {
				if (contentEl) {
					this.renderContent(contentEl, partial);
					contentEl.createEl("div", { cls: "gpt-msg-interrupted", text: t("chat_interrupted") });
				}
				bubble.dataset.raw = partial;
				this.messages.push({ role: "assistant", content: partial });
				await this.plugin.autoSaveSession(this.messages);
			} else if (isAbort) {
				this.messages.pop();
				bubble.parentElement?.remove();
			} else if (err instanceof ModelAccessError && activeProvider === "openai") {
				this.messages.pop();
				bubble.parentElement?.remove();
				const failed   = error.message;
				const failedModel  = err.model ?? activeModel;
				const fallbackModel = isGPT5(failedModel) ? "gpt-4o" : "gpt-4o-mini";
				new FallbackModal(this.plugin.app, {
					failedModel,
					fallbackModel,
					errorMessage: failed,
					onAccept: async (saveAsDefault: boolean) => {
						this.plugin.settings.provider = "openai";
						this.plugin.settings.model = fallbackModel;
						if (saveAsDefault) await this.plugin.saveSettings();
						new Notice(t("notice_fallback_switched", fallbackModel));
						await this.sendMessage(userText);
					},
				}).open();
			} else {
				this.messages.pop();
				if (contentEl) {
					contentEl.empty();
					contentEl.createEl("div", { cls: "gpt-msg-error-line", text: `❌ ${t("err_stream")}: ${error.message}` });
					contentEl.createEl("div", { cls: "gpt-msg-error-detail", text: `Model: ${activeModel} · Mode: ${this.currentMode}` });
					contentEl.addClass("gpt-error");
				}
				console.error("[AI-Vault] sendMessage error:", error.message, err);
			}
		} finally {
			this.sendBtn.disabled = false;
			this.showStopBtn(false);
			this.abortController  = null;
			this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
		}
	}

	// ── System message builder ──────────────────────────────────────────────────

	private lastRagSources: string[] = [];

	private async buildSystemMessage(userText: string): Promise<string> {
		const projId     = this.plugin.activeProjectId;
		const activeProj = projId ? this.plugin.projects.getProject(projId) : null;
		let sys = activeProj?.systemPrompt || this.settings.systemPrompt;

		// Code mode
		if (this.codeMode) {
			sys = t("code_system_prompt_intro") +
				"RULES:\n" +
				"- Write clean, efficient, well-commented code\n" +
				t("code_rule_1") + t("code_rule_2") + t("code_rule_3") +
				t("code_rule_4") +
				"- Format code in blocks ```language\n...```\n" +
				"- Flag potential issues, edge cases and optimizations\n" +
				t("code_rule_5") + t("code_system_prompt_closing");
		}

		if (this.learnMode) sys += t("quiz_instruction");

		const ragSources: string[] = [];

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
				ragSources.push(...this.manualNotes.map(f => f.basename));
				const linked = allNotes.filter(n => !this.manualNotes.some(f => f.path === n.file.path));
				ragSources.push(...linked.map(n => `↳ ${n.file.basename}`));
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
				ragSources.push(...filtered.map(r => r.basename));
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

		if (content) bubble.dataset.raw = content;
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
		const m   = THINKING_MODES[this.currentMode ?? ""];
		const fmt = (n: number): string => n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
		const parts: string[] = [m ? m.label : ""];

		if (usage) {
			parts.push(`${fmt(usage.input + usage.output)} total`);
			parts.push(`${fmt(usage.input)} in`);
			parts.push(`${fmt(usage.output)} out`);
			if (usage.reasoning > 0) parts.push(`${fmt(usage.reasoning)} reasoning`);
		} else {
			parts.push(`${fmt(tokens)} total`);
		}

		this.modeLabel.textContent = parts.join(" · ");

		if (usage) {
			this.modeLabel.title =
				`Input: ${usage.input} tok\nOutput: ${usage.output} tok` +
				(usage.reasoning > 0 ? `\nReasoning: ${usage.reasoning} tok` : "");
		}
	}

	async regenerateLastMessage(): Promise<void> {
		if (this.messages.length < 2) return;
		const rev = [...this.messages].reverse();
		const lastUserIdx = rev.findIndex(m => m.role === "user");
		if (lastUserIdx < 0) return;
		const idx      = this.messages.length - 1 - lastUserIdx;
		const userText = this.messages[idx].content;
		this.messages  = this.messages.slice(0, idx);
		const allMsgs  = this.chatContainer.querySelectorAll(".gpt-msg");
		for (let i = allMsgs.length - 1; i >= idx; i--) allMsgs[i].remove();
		await this.sendMessage(userText);
	}

	async exportToNote(): Promise<void> {
		if (!this.messages.length) { new Notice(t("export_no_messages")); return; }
		const provName  = this.getProviderLabel(this.getEffectiveProvider());
		const title     = this.plugin.currentSession?.title ?? "Conversation";
		const date      = formatDate(Date.now());
		let md          = `# ${title}\n\n> Export from ${provName} · ${date}\n\n---\n\n`;
		for (const msg of this.messages) {
			const label = msg.role === "user" ? "**You**" : `**${provName}**`;
			md += `${label}:\n\n${msg.content}\n\n---\n\n`;
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
		try {
			el.empty();
			if (typeof MarkdownRenderer.render === "function") {
				void MarkdownRenderer.render(this.plugin.app, text, el, "", this.renderComponent);
			} else {
				// Fallback for older Obsidian versions
				(MarkdownRenderer as unknown as {
					renderMarkdown: (md: string, el: HTMLElement, path: string, comp: Component) => void;
				}).renderMarkdown(text, el, "", this.renderComponent);
			}
			this.addCodeCopyButtons(el);
		} catch (e) {
			console.warn("[AI-Vault] native renderer failed, using fallback:", (e as Error)?.message);
			this.renderPlainTextContent(el, text);
			this.addCodeCopyButtons(el);
		}
	}

	private renderPlainTextContent(el: HTMLElement, text: string, withCursor = false): void {
		el.empty();
		const lines = text.split("\n");
		lines.forEach((line, idx) => {
			if (idx > 0) el.createEl("br");
			if (line) el.appendChild(el.ownerDocument.createTextNode(line));
		});
		if (withCursor) el.createEl("span", { cls: "gpt-cursor", text: "▋" });
	}

	private addCodeCopyButtons(container: HTMLElement): void {
		const doc = container.ownerDocument;
		container.querySelectorAll<HTMLElement>(".gpt-code-block pre[data-rawcode]").forEach(pre => {
			if (pre.parentElement?.querySelector(".gpt-code-header")) return;
			const lang = pre.getAttribute("data-lang") ?? "";
			const b64  = pre.getAttribute("data-rawcode") ?? "";

			const header = doc.createElement("div");
			header.className = "gpt-code-header";

			if (lang) {
				const langEl = doc.createElement("span");
				langEl.className   = "gpt-code-lang";
				langEl.textContent = lang;
				header.appendChild(langEl);
			}

			const copyBtn = doc.createElement("button");
			copyBtn.className = "gpt-code-copy";
			copyBtn.title     = "Copy code";
			this.setButtonIcon(copyBtn, "copy", "Copy");
			copyBtn.onclick   = async () => {
				try {
					await navigator.clipboard.writeText(base64ToUtf8(b64));
					this.setButtonIcon(copyBtn, "check", "Copied!");
					copyBtn.classList.add("gpt-code-copy--ok");
					window.setTimeout(() => {
						this.setButtonIcon(copyBtn, "copy", "Copy");
						copyBtn.classList.remove("gpt-code-copy--ok");
					}, 2000);
				} catch (e) { console.warn("[AI-Vault] copy failed:", e); }
			};

			header.appendChild(copyBtn);
			pre.parentElement!.insertBefore(header, pre);
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
			card.createEl("div", { cls: "gpt-quiz-qnum",  text: `Question ${qi + 1} of ${questionCount}` });
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
							fb.textContent = "✅ Correct! ";
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
					checkBtn.textContent = "Checking…";

					if (q.type === "fill") {
						const ok = ans.toLowerCase() === String(q.answer ?? "").toLowerCase().trim();
						const fb = card.createEl("div", { cls: ok ? "gpt-quiz-fb gpt-quiz-fb--ok" : "gpt-quiz-fb gpt-quiz-fb--err" });
						if (ok) { fb.textContent = "✅ Correct!"; }
						else { fb.appendChild(doc.createTextNode(t("quiz_correct_prefix"))); fb.createEl("strong", { text: String(q.answer ?? "") }); }
					} else {
						try {
							const prompt = t("quiz_eval_prompt", q.question, q.answer, ans);
							const activeModel = this.getCurrentActiveModel();
							const provider = this.getEffectiveProvider(activeModel);
							let r: StreamResult;
							if (provider === "anthropic") {
								r = await callClaude(this.settings.claudeApiKey, activeModel, [{ role: "user", content: prompt }], "fast");
							} else if (provider === "local") {
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
