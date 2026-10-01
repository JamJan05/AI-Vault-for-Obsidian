import { App, Modal } from "obsidian";

import { t } from "../i18n";
import { collapseDiff, diffLines } from "../tools/diff";
import type { ProposedChange } from "../tools/noteTools";

const MARKERS = { same: " ", removed: "−", added: "+" } as const;

/**
 * Shows a change the model wants to make and asks whether to write it.
 * Closing the dialog in any other way than the Apply button declines the change.
 */
export class ChangeConfirmModal extends Modal {
	private accepted = false;
	private decided  = false;
	private readonly onAbort = (): void => this.close();

	constructor(
		app: App,
		private readonly change: ProposedChange,
		private readonly signal: AbortSignal | null,
		private readonly onDecision: (accepted: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, change } = this;
		this.modalEl.addClass("gpt-change-modal");
		this.setTitle(t(`edit_modal_title_${change.kind}`));

		// The exchange was stopped or the view closed: nothing may be written any more.
		if (this.signal?.aborted) { this.close(); return; }
		this.signal?.addEventListener("abort", this.onAbort, { once: true });

		contentEl.createDiv({ cls: "gpt-change-path", text: change.path });

		const diffEl = contentEl.createDiv({ cls: "gpt-change-diff" });
		// A canvas is reviewed as its cards and connections, not as raw JSON.
		const shown  = change.preview ?? change;
		const rows   = collapseDiff(diffLines(shown.before, shown.after));
		if (!rows.length) diffEl.createDiv({ cls: "gpt-change-gap", text: t("edit_modal_empty") });

		for (const row of rows) {
			if (row.kind === "gap") {
				diffEl.createDiv({ cls: "gpt-change-gap", text: t("edit_modal_gap", row.skipped) });
				continue;
			}
			const lineEl = diffEl.createDiv({ cls: `gpt-change-line gpt-change-line--${row.kind}` });
			lineEl.createSpan({ cls: "gpt-change-no", text: row.line === null ? "" : String(row.line) });
			lineEl.createSpan({ cls: "gpt-change-marker", text: MARKERS[row.kind] });
			// A changed line that differs only in its line ending would look unchanged.
			const text = row.kind === "same" ? row.text.replace(/\r$/, "") : row.text.replace(/\r$/, "␍");
			lineEl.createSpan({ cls: "gpt-change-text", text });
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons
			.createEl("button", { text: t("edit_modal_reject") })
			.addEventListener("click", () => this.close());
		buttons
			.createEl("button", { text: t("edit_modal_apply"), cls: "mod-cta" })
			.addEventListener("click", () => {
				this.accepted = true;
				this.close();
			});
	}

	onClose(): void {
		this.signal?.removeEventListener("abort", this.onAbort);
		this.contentEl.empty();
		if (this.decided) return;
		this.decided = true;
		this.onDecision(this.accepted && !this.signal?.aborted);
	}
}
