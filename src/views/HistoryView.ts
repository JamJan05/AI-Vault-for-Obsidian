import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import { HISTORY_VIEW_TYPE, PROJECTS_VIEW_TYPE } from "../constants";
import { t } from "../i18n";
import { formatDate } from "../utils";
import { ConfirmModal } from "./ConfirmModal";
import type { HistoryManager } from "../history/HistoryManager";
import type { ProjectManager } from "../history/ProjectManager";

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

	private setIconOnly(el: HTMLElement, icon: string): void {
		el.empty();
		setIcon(el, icon);
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
		this.setIconOnly(closeBtn, "x");
		closeBtn.onclick = () => {
			const leaves = this.plugin.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE);
			leaves[0]?.detach();
		};
	}

	private buildProjectsShortcut(root: HTMLElement): void {
		const projCount = this.plugin.projects.projects.length;
		const btn = root.createEl("div", { cls: "gpt-projects-shortcut" });
		setIcon(btn, "folder");
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
			this.setIconOnly(delBtn, "trash-2");
			delBtn.onclick   = (e: MouseEvent) => {
				e.stopPropagation();
				new ConfirmModal(
					this.plugin.app,
					t("history_delete_chat_confirm", session.title.slice(0, 40)),
					async () => {
						await this.plugin.history.deleteSession(session.id);
						if (this.plugin.currentSessionId === session.id) this.plugin.newChat();
						this.render();
					},
					t("history_delete_btn"),
					t("chat_notes_cancel"),
				).open();
			};

			item.createEl("div", { cls: "gpt-history-item-date",    text: formatDate(session.updatedAt) });
			item.createEl("div", { cls: "gpt-history-item-preview", text: session.preview ?? "…" });
			item.onclick = () => void this.plugin.loadSession(session.id);
		}
	}
}
