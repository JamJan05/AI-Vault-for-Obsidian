import { App, Modal } from "obsidian";
import { t } from "../i18n";
import { isGPT5 } from "../models";

interface FallbackModalOptions {
	failedModel:   string;
	fallbackModel: string;
	errorMessage?: string;
	onAccept?:     (saveAsDefault: boolean) => Promise<void>;
}

/**
 * Modal shown when the selected model is unavailable for the user's account (403/404).
 * Suggests switching to a fallback model (usually gpt-4o) and retrying the message.
 * Optionally saves the fallback as the default model in settings.
 */
export class FallbackModal extends Modal {
	private readonly failedModel:   string;
	private readonly fallbackModel: string;
	private readonly errorMessage:  string;
	private readonly onAccept?:     (saveAsDefault: boolean) => Promise<void>;
	private saveAsDefault = false;

	constructor(app: App, opts: FallbackModalOptions) {
		super(app);
		this.failedModel   = opts.failedModel;
		this.fallbackModel = opts.fallbackModel;
		this.errorMessage  = opts.errorMessage ?? "";
		this.onAccept      = opts.onAccept;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gpt-fallback-modal");

		contentEl.createEl("h2", { text: t("fallback_title") });

		const desc = contentEl.createEl("div", { cls: "gpt-fallback-desc" });
		desc.createEl("p", { text: t("fallback_unavailable", this.failedModel) });

		// Hint for GPT-5 — most common cause: no Tier 1 access
		if (isGPT5(this.failedModel)) {
			const parts = t("fallback_tier1").split(": ");
			const hint  = desc.createEl("div", { cls: "gpt-fallback-hint" });
			hint.createEl("strong", { text: parts[0] + ": " });
			hint.appendText(parts.slice(1).join(": "));
		}

		// API error details
		if (this.errorMessage) {
			const errBox = desc.createEl("div", { cls: "gpt-fallback-err" });
			errBox.createEl("span", { text: t("fallback_api_error") });
			errBox.createEl("code", { text: this.errorMessage });
		}

		desc.createEl("p", { text: t("fallback_suggest", this.fallbackModel) });

		// Checkbox: save as default model
		const checkRow = contentEl.createEl("div", { cls: "gpt-fallback-check" });
		const checkbox = checkRow.createEl("input", {
			type: "checkbox",
			attr: { id: "gpt-fallback-save-default" },
		});
		checkRow.createEl("label", {
			text: " " + t("fallback_save_default", this.fallbackModel),
			attr: { for: "gpt-fallback-save-default" },
		});
		checkbox.addEventListener("change", () => {
			this.saveAsDefault = checkbox.checked;
		});

		// Przyciski
		const btnRow = contentEl.createEl("div", { cls: "gpt-fallback-buttons" });

		const cancelBtn = btnRow.createEl("button", { text: t("chat_notes_cancel") });
		cancelBtn.addEventListener("click", () => this.close());

		const acceptBtn = btnRow.createEl("button", {
			cls:  "mod-cta",
			text: t("fallback_accept", this.fallbackModel),
		});
		acceptBtn.addEventListener("click", () => {
			this.close();
			void this.acceptFallback();
		});
	}

	private async acceptFallback(): Promise<void> {
		try {
			await this.onAccept?.(this.saveAsDefault);
		} catch (e) {
			console.error("[AI-Vault] Fallback retry failed:", e);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
