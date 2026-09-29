import { App, Modal } from "obsidian";
import { t } from "../i18n";

type ConsentHandler = () => void | Promise<void>;

/**
 * Shown before semantic search is switched on. Turning it on sends note text to
 * OpenAI, so the user is told exactly what leaves the device, where it goes and
 * who pays for it — and nothing is enabled unless they confirm.
 */
export class EmbeddingsConsentModal extends Modal {
	private accepted = false;

	constructor(
		app: App,
		private readonly onAccept:  ConsentHandler,
		private readonly onDecline: ConsentHandler,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("gpt-consent-modal");

		this.setTitle(t("consent_embeddings_title"));
		contentEl.createEl("p", { text: t("consent_embeddings_intro") });

		const list = contentEl.createEl("ul", { cls: "gpt-consent-list" });
		for (const key of [
			"consent_embeddings_item_notes",
			"consent_embeddings_item_questions",
			"consent_embeddings_item_ignored",
			"consent_embeddings_item_cost",
			"consent_embeddings_item_local",
			"consent_embeddings_item_undo",
		]) {
			list.createEl("li", { text: t(key) });
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons
			.createEl("button", { text: t("chat_notes_cancel") })
			.addEventListener("click", () => this.close());

		const acceptButton = buttons.createEl("button", {
			text: t("consent_embeddings_accept"),
			cls:  "mod-cta",
		});
		acceptButton.addEventListener("click", () => {
			this.accepted = true;
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		// Closing with Escape or the close button counts as declining.
		const handler = this.accepted ? this.onAccept : this.onDecline;
		void Promise.resolve(handler())
			.catch(err => console.error("[AI-Vault] Consent action failed:", err));
	}
}
