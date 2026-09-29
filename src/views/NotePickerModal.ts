import { App, Modal } from "obsidian";
import type { TFile } from "obsidian";
import { t } from "../i18n";

const MAX_VISIBLE = 50;

/**
 * Lets the user pick the notes to attach to the next messages.
 * Attaching is an explicit choice: only the files ticked here are sent.
 */
export class NotePickerModal extends Modal {
	private readonly selected: Set<string>;
	private listEl!: HTMLElement;

	constructor(
		app: App,
		private readonly files:    TFile[],
		preselected:               TFile[],
		private readonly onSubmit: (files: TFile[]) => void,
	) {
		super(app);
		this.selected = new Set(preselected.map(f => f.path));
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gpt-note-picker");
		this.setTitle(t("chat_notes_title"));

		const searchInput = contentEl.createEl("input", {
			cls:  "gpt-note-picker-search",
			attr: { type: "text", placeholder: t("chat_notes_search") },
		});
		searchInput.addEventListener("input", () => this.renderList(searchInput.value));
		searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") { e.preventDefault(); this.submit(); }
		});

		this.listEl = contentEl.createDiv({ cls: "gpt-note-picker-list" });
		this.renderList("");

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons
			.createEl("button", { text: t("chat_notes_cancel") })
			.addEventListener("click", () => this.close());
		buttons
			.createEl("button", { text: t("chat_notes_add"), cls: "mod-cta" })
			.addEventListener("click", () => this.submit());

		searchInput.focus();
	}

	private renderList(filter: string): void {
		this.listEl.empty();
		const needle   = filter.trim().toLowerCase();
		const filtered = needle
			? this.files.filter(f => f.path.toLowerCase().includes(needle))
			: this.files;

		if (!filtered.length) {
			this.listEl.createDiv({ cls: "gpt-note-picker-more", text: t("chat_notes_none") });
			return;
		}

		for (const file of filtered.slice(0, MAX_VISIBLE)) {
			const row      = this.listEl.createEl("label", { cls: "gpt-note-picker-row" });
			const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
			checkbox.checked = this.selected.has(file.path);
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) this.selected.add(file.path);
				else this.selected.delete(file.path);
			});

			const label = row.createSpan({ cls: "gpt-note-picker-label" });
			label.createSpan({ text: file.basename });
			if (file.extension === "canvas") label.createSpan({ cls: "gpt-note-picker-tag", text: "canvas" });
			const folder = file.parent?.path ?? "";
			if (folder && folder !== "/") label.createSpan({ cls: "gpt-note-picker-path", text: folder });
		}

		if (filtered.length > MAX_VISIBLE) {
			this.listEl.createDiv({
				cls:  "gpt-note-picker-more",
				text: t("chat_notes_more", filtered.length - MAX_VISIBLE),
			});
		}
	}

	private submit(): void {
		this.onSubmit(this.files.filter(f => this.selected.has(f.path)));
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
