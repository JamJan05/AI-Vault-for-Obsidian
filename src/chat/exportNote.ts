/**
 * Turns a conversation into the Markdown note written by "Export to note".
 * Free of Obsidian imports; the view does the file operations.
 */

import { t } from "../i18n";
import type { ChatMessage } from "../types";

export const EXPORT_FOLDER = "AI-Vault";
const MAX_TITLE_CHARS = 60;

export interface ExportInput {
	title:         string;
	model:         string;
	providerLabel: string;
	/** Already formatted for display. */
	date:          string;
	messages:      ChatMessage[];
}

export function buildExportMarkdown(input: ExportInput): string {
	let markdown = t("export_header", input.title, input.model || input.providerLabel, input.date);
	for (const message of input.messages) {
		if (message.role === "system") continue;
		const label = message.role === "user" ? t("export_user") : `**${input.providerLabel}:**`;
		markdown += `${label}\n\n${message.content}\n\n---\n\n`;
	}
	return markdown;
}

/**
 * File name for a conversation title. Characters that are not allowed in file
 * names — or that would turn the name into a path — become underscores.
 */
export function exportFileName(title: string): string {
	const cleaned = (title ?? "")
		.replace(/[\\/:*?"<>|#^[\]]/g, "_")
		.replace(/\.{2,}/g, "_")
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+/, "")
		.trim()
		.slice(0, MAX_TITLE_CHARS)
		.trim();
	// A title made only of replaced characters says nothing; use a plain name.
	return /[^_\s]/.test(cleaned) ? cleaned : "conversation";
}

/** Vault path without extension: `AI-Vault/<title> <yyyy-mm-dd>`. */
export function exportBasePath(title: string, when: Date): string {
	return `${EXPORT_FOLDER}/${exportFileName(title)} ${when.toISOString().slice(0, 10)}`;
}

/** First path that is not taken: `base.md`, `base (1).md`, `base (2).md`, … */
export function firstFreePath(base: string, isTaken: (path: string) => boolean): string {
	let path = `${base}.md`;
	for (let n = 1; isTaken(path) && n < 1000; n++) path = `${base} (${n}).md`;
	return path;
}
