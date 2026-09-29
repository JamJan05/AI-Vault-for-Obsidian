import { t } from "../i18n";
import type { ModelGroup, ModelOption } from "../chat/modelOptions";
import type { Provider } from "../settings";

interface ModelPickerOptions {
	/** The button the list opens under. */
	anchor:   HTMLElement;
	groups:   ModelGroup[];
	active:   { provider: Provider; model: string };
	onSelect: (provider: Provider, model: ModelOption) => void;
}

/**
 * The list of models that opens under the model button. It is attached to the
 * document body — not the panel — to escape Obsidian's CSS transforms.
 */
export class ModelPicker {
	private el: HTMLElement | null = null;
	private closeHandler: ((e: MouseEvent) => void) | null = null;

	get isOpen(): boolean { return this.el !== null; }

	open(options: ModelPickerOptions): void {
		this.close();

		const doc    = options.anchor.ownerDocument;
		const picker = doc.body.createDiv({ cls: "gpt-model-picker" });
		this.el = picker;

		for (const group of options.groups) {
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

				const isActive = group.provider === options.active.provider && model.id === options.active.model;
				const row = picker.createEl("button", {
					cls:  "gpt-mp-row" + (isActive ? " gpt-mp-row--active" : ""),
					attr: { type: "button" },
				});

				const left = row.createSpan({ cls: "gpt-mp-row-left" });
				left.createSpan({ cls: "gpt-mp-row-name", text: model.label });
				left.createSpan({ cls: "gpt-mp-row-desc", text: model.desc });
				if (isActive) row.createSpan({ cls: "gpt-mp-row-check", text: "✓" });

				row.addEventListener("mousedown", (e) => e.stopPropagation());
				row.addEventListener("click", () => {
					this.close();
					options.onSelect(group.provider, model);
				});
			}
		}

		const rect = options.anchor.getBoundingClientRect();
		picker.setCssStyles({
			top:  `${rect.bottom + 4}px`,
			left: `${rect.left}px`,
		});

		// Close on a click outside. Registered on the next tick, so the click that
		// opened the list cannot close it again.
		this.closeHandler = (e: MouseEvent): void => {
			const target = e.target as Node | null;
			if (!target) return;
			if (!picker.contains(target) && !options.anchor.contains(target)) this.close();
		};
		window.setTimeout(() => {
			if (this.closeHandler) doc.addEventListener("mousedown", this.closeHandler);
		}, 0);
	}

	close(): void {
		if (this.closeHandler) {
			this.el?.ownerDocument.removeEventListener("mousedown", this.closeHandler);
			this.closeHandler = null;
		}
		this.el?.remove();
		this.el = null;
	}
}
