import { MarkdownView, Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import { t } from "../i18n";
import { locateChunk } from "../rag/locate";
import type { MessageSource } from "../types";

/**
 * Opens the note behind a source. For a search result it goes to the fragment
 * the model was given and selects it. Everything happens on the device.
 */
export async function openSource(app: App, source: MessageSource): Promise<void> {
	const file = app.vault.getAbstractFileByPath(source.path);
	if (!(file instanceof TFile)) {
		new Notice(t("rag_source_missing", source.label));
		return;
	}

	const canLocate = Boolean(source.anchor) && file.extension === "md";
	let range = null;
	if (canLocate) {
		try {
			const content = await app.vault.cachedRead(file);
			range = locateChunk(content, source.anchor ?? "");
			// The anchor is only the beginning — extend to the whole fragment.
			if (range && source.length) {
				range.end = Math.min(content.length, Math.max(range.end, range.start + source.length));
			}
		} catch (e) {
			console.warn("[AI-Vault] could not read source note:", (e as Error)?.message);
		}
	}

	const leaf = app.workspace.getLeaf(false);
	await leaf.openFile(file, range ? { eState: { line: range.line } } : undefined);

	if (range && leaf.view instanceof MarkdownView) {
		const editor = leaf.view.editor;
		const from   = editor.offsetToPos(range.start);
		const to     = editor.offsetToPos(range.end);
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	} else if (canLocate && !range) {
		new Notice(t("rag_source_moved"));
	}
}

/** Draws the sources of an answer as buttons under its bubble. */
export function renderSources(app: App, bubble: HTMLElement, sources: MessageSource[]): void {
	const msgEl = bubble.parentElement;
	if (!msgEl || !sources.length) return;

	const srcEl = msgEl.createDiv({ cls: "gpt-rag-sources" });
	srcEl.createSpan({ cls: "gpt-rag-src-icon",  text: "🗄️" });
	srcEl.createSpan({ cls: "gpt-rag-src-label", text: t("rag_sources_label") });

	for (const source of sources) {
		const chip = srcEl.createEl("button", {
			cls:  "gpt-rag-src-chip",
			text: source.label,
			attr: { type: "button", title: t(source.anchor ? "rag_source_open_at" : "rag_source_open") },
		});
		chip.onclick = () => void openSource(app, source);
	}
}
