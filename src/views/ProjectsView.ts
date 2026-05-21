import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { PROJECTS_VIEW_TYPE } from "../constants";
import { t } from "../i18n";
import { formatDate } from "../utils";
import type { Project } from "../types";
import type { HistoryManager } from "../history/HistoryManager";
import type { ProjectManager } from "../history/ProjectManager";

// ─── SVG icons ────────────────────────────────────────────────────────────────

const SVG_CLOSE  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const SVG_DELETE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>`;
const SVG_EDIT   = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const SVG_CHAT   = `<svg class="gpt-projects-card-chat-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const SVG_PROMPT = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;

// ─── Plugin interface ──────────────────────────────────────────────────────────

interface PluginWithDeps {
	app:              import("obsidian").App;
	history:          HistoryManager;
	projects:         ProjectManager;
	currentSessionId: string | null;
	activeProjectId:  string | null;
	newChat():        void;
	loadSession(id: string): Promise<void>;
	setActiveProject(id: string | null): void;
	activateHistoryView(): Promise<void>;
}

// ─── View ──────────────────────────────────────────────────────────────────────

export class GPTProjectsView extends ItemView {
	private readonly plugin: PluginWithDeps;

	constructor(leaf: WorkspaceLeaf, plugin: PluginWithDeps) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType():    string { return PROJECTS_VIEW_TYPE; }
	getDisplayText(): string { return t("projects_title"); }
	getIcon():        string { return "folder-open"; }

	async onOpen():  Promise<void> {
		await this.plugin.projects.load();
		this.render();
	}
	async onClose(): Promise<void> { /* cleanup handled by Obsidian */ }

	render(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("gpt-projects-root");

		this.buildHeader(root);
		this.buildActiveBar(root);
		this.buildProjectList(root);
	}

	// ── Sekcje ─────────────────────────────────────────────────────────────────

	private buildHeader(root: HTMLElement): void {
		const header = root.createEl("div", { cls: "gpt-projects-header" });

		const backBtn = header.createEl("button", { cls: "gpt-pill-btn", text: t("projects_btn_back") });
		backBtn.onclick = () => void this.plugin.activateHistoryView();

		header.createEl("span", { cls: "gpt-header-title", text: "📁 " + t("projects_title") });

		const newBtn = header.createEl("button", { cls: "gpt-pill-btn", text: t("projects_btn_new") });
		newBtn.onclick = () => this.showCreateDialog();

		const closeBtn = header.createEl("button", {
			cls:  "gpt-icon-btn",
			attr: { "aria-label": "Zamknij" },
		});
		closeBtn.innerHTML = SVG_CLOSE;
		closeBtn.onclick = () => {
			const leaves = this.plugin.app.workspace.getLeavesOfType(PROJECTS_VIEW_TYPE);
			leaves[0]?.detach();
		};
	}

	private buildActiveBar(root: HTMLElement): void {
		if (!this.plugin.activeProjectId) return;
		const proj = this.plugin.projects.getProject(this.plugin.activeProjectId);
		if (!proj) return;

		const bar = root.createEl("div", { cls: "gpt-projects-active-bar" });
		bar.style.background        = `color-mix(in srgb,${proj.color} 12%,var(--background-secondary))`;
		bar.style.borderBottomColor = `color-mix(in srgb,${proj.color} 25%,transparent)`;

		const dot = bar.createEl("span", { cls: "gpt-projects-active-dot" });
		dot.style.background = proj.color;

		bar.createEl("span", {
			cls:  "gpt-projects-active-name",
			text: `${t("projects_active")} ${proj.name}`,
		});

		const exitBtn = bar.createEl("button", { cls: "gpt-pill-btn", text: t("projects_leave_btn") });
		exitBtn.onclick = () => { this.plugin.setActiveProject(null); this.render(); };
	}

	private buildProjectList(root: HTMLElement): void {
		const list     = root.createEl("div", { cls: "gpt-projects-list" });
		const projects = this.plugin.projects.projects;

		if (!projects.length) {
			const empty = list.createEl("div", { cls: "gpt-projects-empty" });
			empty.createEl("div", { text: t("projects_empty") });
			empty.createEl("div", {
				cls:  "gpt-projects-empty-hint",
				text: t("projects_empty_hint_long"),
			});
			return;
		}

		for (const proj of projects) {
			this.buildProjectCard(list, proj);
		}
	}

	private buildProjectCard(list: HTMLElement, proj: Project): void {
		const sessions = this.plugin.projects.getProjectSessions(proj.id);
		const isActive = this.plugin.activeProjectId === proj.id;

		const card = list.createEl("div", { cls: "gpt-projects-card" });
		if (isActive) {
			card.style.borderColor  = proj.color;
			card.style.background   = `color-mix(in srgb,${proj.color} 8%,var(--background-secondary))`;
		}

		// ── Card header ─────────────────────────────────────────────────────────
		const top = card.createEl("div", { cls: "gpt-projects-card-top" });

		const dot = top.createEl("span", { cls: "gpt-projects-card-dot" });
		dot.style.background = proj.color;

		top.createEl("span", { cls: "gpt-projects-card-name", text: proj.name });

		const badge = top.createEl("span", {
			cls:  "gpt-projects-card-badge",
			text: t("projects_chat_count", sessions.length),
		});
		badge.style.background = `color-mix(in srgb,${proj.color} 15%,var(--background-primary))`;
		badge.style.color      = proj.color;

		// Edit button
		const editBtn = top.createEl("button", {
			cls:  "gpt-projects-icon-btn",
			attr: { "aria-label": "Edytuj" },
		});
		editBtn.innerHTML = SVG_EDIT;
		editBtn.onclick   = (e: MouseEvent) => { e.stopPropagation(); this.showCreateDialog(proj); };

		// Delete button
		const delBtn = top.createEl("button", {
			cls:  "gpt-projects-icon-btn",
			attr: { "aria-label": t("history_delete_btn") },
		});
		delBtn.innerHTML = SVG_DELETE;
		delBtn.onclick   = async (e: MouseEvent) => {
			e.stopPropagation();
			if (!confirm(t("projects_delete_with_count", proj.name, sessions.length))) return;
			if (this.plugin.activeProjectId === proj.id) this.plugin.setActiveProject(null);
			await this.plugin.projects.deleteProject(proj.id);
			this.render();
		};

		// Custom prompt — badge
		if (proj.systemPrompt) {
			const tag = card.createEl("div", { cls: "gpt-projects-card-prompt-tag" });
			tag.style.background   = `color-mix(in srgb,${proj.color} 10%,var(--background-primary))`;
			tag.style.color        = proj.color;
			tag.style.borderColor  = `color-mix(in srgb,${proj.color} 20%,transparent)`;
			tag.innerHTML          = `${SVG_PROMPT} ${t("projects_own_prompt_btn")}`;
		}

		// ── Chat list ───────────────────────────────────────────────────────────
		if (sessions.length) {
			const chatList = card.createEl("div", { cls: "gpt-projects-card-chats" });

			for (const s of sessions.slice(0, 5)) {
				const row = chatList.createEl("div", { cls: "gpt-projects-card-chat" });
				row.innerHTML = SVG_CHAT;
				row.createEl("span", { cls: "gpt-projects-card-chat-title", text: s.title.slice(0, 40) });
				row.createEl("span", { cls: "gpt-projects-card-chat-date",  text: formatDate(s.updatedAt) });

				const chatDel = row.createEl("button", {
					cls:  "gpt-projects-card-chat-del",
					attr: { "aria-label": t("history_delete_btn") },
				});
				chatDel.innerHTML = SVG_DELETE;
				chatDel.onclick   = async (e: MouseEvent) => {
					e.stopPropagation();
					if (!confirm(t("projects_chat_delete_confirm", s.title.slice(0, 40)))) return;
					await this.plugin.history.deleteSession(s.id);
					if (this.plugin.currentSessionId === s.id) this.plugin.newChat();
					this.render();
				};

				row.onclick = (e: MouseEvent) => {
					e.stopPropagation();
					void this.plugin.loadSession(s.id);
				};
			}

			if (sessions.length > 5) {
				chatList.createEl("div", {
					cls:  "gpt-projects-card-more",
					text: t("projects_more_chats", sessions.length - 5),
				});
			}
		}

		card.onclick = () => { this.plugin.setActiveProject(proj.id); this.render(); };
	}

	// ── Dialog tworzenia / edycji projektu ─────────────────────────────────────

	showCreateDialog(editProject?: Project): void {
		const isEdit  = !!editProject;
		const overlay = document.createElement("div");
		overlay.className = "gpt-modal-overlay";

		const box = document.createElement("div");
		box.className = "gpt-modal-box";

		box.createEl("p", {
			cls:  "gpt-modal-title",
			text: isEdit ? `Edytuj projekt: ${editProject!.name}` : "Nowy projekt:",
		});

		const nameInput = box.createEl("input", {
			cls:  "gpt-modal-input",
			attr: { type: "text", placeholder: "Nazwa projektu…" },
		}) as HTMLInputElement;
		if (isEdit) nameInput.value = editProject!.name;

		const promptLabel = box.createEl("div", { cls: "gpt-modal-prompt-label" });
		promptLabel.innerHTML = `${SVG_EDIT} ${t("projects_prompt_label")}`;

		const promptInput = box.createEl("textarea", {
			cls:  "gpt-modal-input gpt-modal-prompt-area",
			attr: { placeholder: t("projects_prompt_placeholder") },
		}) as HTMLTextAreaElement;
		if (isEdit) promptInput.value = editProject!.systemPrompt ?? "";

		box.createEl("div", { cls: "gpt-modal-prompt-hint", text: t("projects_prompt_hint") });

		// Przyciski
		const btns   = box.createEl("div", { cls: "gpt-modal-btns" });
		const cancel = btns.createEl("button", {
			cls:  "gpt-modal-cancel",
			text: t("chat_notes_cancel"),
		});
		cancel.onclick = () => overlay.remove();

		const ok = btns.createEl("button", {
			cls:  "gpt-modal-ok",
			text: isEdit ? "Zapisz" : t("projects_create_btn"),
		});
		ok.onclick = async () => {			const name = nameInput.value.trim();
			if (!name) { nameInput.style.borderColor = "var(--color-red)"; return; }

			if (isEdit) {
				await this.plugin.projects.updateProject(editProject!.id, {
					name,
					systemPrompt: promptInput.value.trim(),
				});
				overlay.remove();
				this.render();
				new Notice(t("projects_updated", name));
			} else {
				const proj = await this.plugin.projects.createProject(
					name,
					"",
					promptInput.value.trim(),
				);
				this.plugin.setActiveProject(proj.id);
				overlay.remove();
				this.render();
				new Notice(t("projects_created", name));
			}
		};

		nameInput.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") void (ok.onclick as (() => Promise<void>) | null)?.();
		});

		overlay.appendChild(box);
		this.containerEl.appendChild(overlay);
		setTimeout(() => nameInput.focus(), 50);
	}
}
