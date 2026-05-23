import { App, Modal } from "obsidian";

type ConfirmHandler = () => void | Promise<void>;

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly message: string,
		private readonly onConfirm: ConfirmHandler,
		private readonly confirmText: string,
		private readonly cancelText: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons
			.createEl("button", { text: this.cancelText })
			.addEventListener("click", () => this.close());

		const confirmButton = buttons.createEl("button", {
			text: this.confirmText,
			cls:  "mod-warning",
		});
		confirmButton.addEventListener("click", () => {
			confirmButton.disabled = true;
			void Promise.resolve(this.onConfirm())
				.catch(err => console.error("[AI-Vault] Confirm action failed:", err))
				.finally(() => this.close());
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
