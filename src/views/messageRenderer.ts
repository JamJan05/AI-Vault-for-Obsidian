import { MarkdownRenderer, setIcon } from "obsidian";
import type { App, Component } from "obsidian";
import { t } from "../i18n";

const COPIED_MS = 2000;

/** Replaces a button's content with an icon and an optional label. */
export function setButtonIcon(button: HTMLElement, icon: string, label?: string): void {
	button.empty();
	setIcon(button, icon);
	if (label) button.createSpan({ text: label });
}

/** Plain text with line breaks — the fallback when Markdown rendering fails. */
export function renderPlainText(el: HTMLElement, text: string): void {
	el.empty();
	text.split("\n").forEach((line, index) => {
		if (index > 0) el.createEl("br");
		if (line) el.appendText(line);
	});
}

/** Adds a copy button to each code block that Obsidian has not given one already. */
export function addCodeCopyButtons(container: HTMLElement): void {
	container.querySelectorAll<HTMLElement>("pre > code").forEach(code => {
		const pre = code.parentElement;
		if (!pre || pre.querySelector(".copy-code-button, .gpt-code-copy")) return;

		pre.addClass("gpt-code-block");
		const copyBtn = pre.createEl("button", {
			cls:  "gpt-code-copy",
			attr: { title: t("chat_copy_code"), "aria-label": t("chat_copy_code") },
		});
		setButtonIcon(copyBtn, "copy");
		copyBtn.onclick = async () => {
			try {
				await navigator.clipboard.writeText(code.textContent ?? "");
				setButtonIcon(copyBtn, "check");
				copyBtn.addClass("gpt-code-copy--ok");
				window.setTimeout(() => {
					setButtonIcon(copyBtn, "copy");
					copyBtn.removeClass("gpt-code-copy--ok");
				}, COPIED_MS);
			} catch (e) {
				console.warn("[AI-Vault] copy failed:", (e as Error)?.message);
			}
		};
	});
}

/**
 * Renders a message with Obsidian's own Markdown renderer. Model output is only
 * ever rendered — nothing in it is executed.
 */
export async function renderMarkdown(
	app:       App,
	component: Component,
	el:        HTMLElement,
	text:      string,
): Promise<void> {
	el.empty();
	try {
		await MarkdownRenderer.render(app, text, el, "", component);
	} catch (e) {
		console.warn("[AI-Vault] native renderer failed, using fallback:", (e as Error)?.message);
		renderPlainText(el, text);
	}
	// Rendering is asynchronous — the code blocks only exist now.
	addCodeCopyButtons(el);
}

/** Copy button for a whole message. */
export function attachCopyButton(button: HTMLElement, getText: () => string): void {
	setButtonIcon(button, "copy");
	button.onclick = async () => {
		try {
			await navigator.clipboard.writeText(getText());
			setButtonIcon(button, "check");
			window.setTimeout(() => setButtonIcon(button, "copy"), COPIED_MS);
		} catch (e) {
			console.error("[AI-Vault] Copy failed:", (e as Error)?.message);
		}
	};
}
