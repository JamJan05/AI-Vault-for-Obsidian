import { ItemView, WorkspaceLeaf } from "obsidian";
import { HISTORY_VIEW_TYPE, PROJECTS_VIEW_TYPE } from "../constants";
import { t } from "../i18n";
import { formatDate } from "../utils";
import type { HistoryManager } from "../history/HistoryManager";
import type { ProjectManager } from "../history/ProjectManager";

// SVG helpers — inline SVG for icons (Obsidian's Lucide set doesn't include these)
const SVG_CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const SVG_FOLDER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const SVG_DELETE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>`;

interface PluginWithDeps {
	app:              import("obsidian").App;
	history:          HistoryManager;
	projects:         ProjectManager;
	currentSessionId: string | null;
	newChat():        void;
	loadSession(id: string): Promise<void>;
	activateProjectsView(): Promise<void>;
}

export class GPTHistoryView extends ItemView {
	private readonly plugin: PluginWithDeps;

	constructor(leaf: WorkspaceLeaf, plugin: PluginWithDeps) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType():    string { return HISTORY_VIEW_TYPE; }
	getDisplayText(): string { return t("history_title"); }
	getIcon():        string { return "clock"; }

	async onOpen():  Promise<void> {
		await this.plugin.history.load();
		this.render();
	}
	async onClose(): Promise<void> { /* cleanup handled by Obsidian */ }

	render(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("gpt-history-root");

		this.buildHeader(root);
		this.buildProjectsShortcut(root);
		this.buildSessionList(root);
	}

	// ── Sekcje ─────────────────────────────────────────────────────────────────

	private buildHeader(root: HTMLElement): void {
		const header = root.createEl("div", { cls: "gpt-history-header" });
		header.createEl("span", { cls: "gpt-header-title", text: t("history_title") });

		const newBtn = header.createEl("button", { cls: "gpt-pill-btn", text: t("history_btn_new") });
		newBtn.onclick = () => this.plugin.newChat();

		const closeBtn = header.createEl("button", {
			cls:  "gpt-icon-btn",
			attr: { "aria-label": "Zamknij" },
		});
		closeBtn.innerHTML = SVG_CLOSE;
		closeBtn.onclick = () => {
			const leaves = this.plugin.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE);
			leaves[0]?.detach();
		};
	}

	private buildProjectsShortcut(root: HTMLElement): void {
		const projCount = this.plugin.projects.projects.length;
		const btn = root.createEl("div", { cls: "gpt-projects-shortcut" });
		btn.innerHTML = SVG_FOLDER;
		btn.createEl("span", { cls: "gpt-projects-shortcut-label", text: t("chat_projects") });
		if (projCount) {
			btn.createEl("span", {
				cls:  "gpt-projects-shortcut-badge",
				text: String(projCount),
			});
		}
		btn.createEl("span", { cls: "gpt-projects-shortcut-arrow", text: "›" });
		btn.onclick = () => void this.plugin.activateProjectsView();
	}

	private buildSessionList(root: HTMLElement): void {
		const list     = root.createEl("div", { cls: "gpt-history-list" });
		const sessions = this.plugin.history.sessions.filter(s => !s.projectId);

		if (!sessions.length) {
			list.createEl("div", { cls: "gpt-history-empty",      text: t("history_empty") });
			list.createEl("div", { cls: "gpt-history-empty-hint", text: t("history_chats_in_projects") });
			return;
		}

		for (const session of sessions) {
			const item = list.createEl("div", { cls: "gpt-history-item" });
			if (this.plugin.currentSessionId === session.id) {
				item.addClass("gpt-history-item--active");
			}

			// Row header: title + delete button
			const top = item.createEl("div", { cls: "gpt-history-item-top" });
			top.createEl("span", { cls: "gpt-history-item-title", text: session.title });

			const delBtn = top.createEl("button", {
				cls:  "gpt-history-item-del",
				attr: { "aria-label": t("history_delete_btn") },
			});
			delBtn.innerHTML = SVG_DELETE;
			delBtn.onclick   = async (e: MouseEvent) => {
				e.stopPropagation();
				if (!confirm(t("history_delete_chat_confirm", session.title.slice(0, 40)))) return;
				await this.plugin.history.deleteSession(session.id);
				if (this.plugin.currentSessionId === session.id) this.plugin.newChat();
				this.render();
			};

			item.createEl("div", { cls: "gpt-history-item-date",    text: formatDate(session.updatedAt) });
			item.createEl("div", { cls: "gpt-history-item-preview", text: session.preview ?? "…" });
			item.onclick = () => void this.plugin.loadSession(session.id);
		}
	}
}
