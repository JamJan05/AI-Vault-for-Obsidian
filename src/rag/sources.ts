/**
 * Sources kept with an answer in the conversation history.
 *
 * A source stores where the fragment came from, not the fragment: only a short
 * anchor from its beginning is kept, enough to find the passage again. Session
 * files are read back from disk, so what comes out of them is validated here.
 */

import type { MessageSource } from "../types";

/** Characters of the fragment kept to find it again. */
export const SOURCE_ANCHOR_CHARS = 200;
const MAX_SOURCES       = 20;
const MAX_LABEL_CHARS   = 200;
const MAX_PATH_CHARS    = 1024;
/** Longest span a source may select; an indexed fragment is far shorter. */
const MAX_SOURCE_LENGTH = 20_000;

export function toMessageSource(label: string, path: string, chunk?: string): MessageSource {
	const source: MessageSource = { label, path };
	const text = chunk?.trim();
	if (text) {
		source.anchor = text.slice(0, SOURCE_ANCHOR_CHARS);
		source.length = Math.min(text.length, MAX_SOURCE_LENGTH);
	}
	return source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** A vault-relative path: no absolute path, no parent segments, no control characters. */
function isVaultPath(path: string): boolean {
	if (!path || path.length > MAX_PATH_CHARS) return false;
	if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path)) return false;
	for (let i = 0; i < path.length; i++) {
		if (path.charCodeAt(i) < 32) return false;
	}
	return !path.split(/[\\/]/).includes("..");
}

/**
 * Returns the well-formed sources from a stored message and drops the rest.
 * Never throws: a damaged session file loses its sources, not the conversation.
 */
export function sanitizeSources(value: unknown): MessageSource[] {
	if (!Array.isArray(value)) return [];
	const sources: MessageSource[] = [];

	for (const item of value) {
		if (sources.length >= MAX_SOURCES) break;
		if (!isRecord(item)) continue;
		if (typeof item.label !== "string" || typeof item.path !== "string") continue;

		const label = item.label.trim().slice(0, MAX_LABEL_CHARS);
		if (!label || !isVaultPath(item.path)) continue;

		const source: MessageSource = { label, path: item.path };
		if (typeof item.anchor === "string" && item.anchor.trim()) {
			source.anchor = item.anchor.slice(0, SOURCE_ANCHOR_CHARS);
			if (typeof item.length === "number" && Number.isFinite(item.length) && item.length > 0) {
				source.length = Math.min(Math.floor(item.length), MAX_SOURCE_LENGTH);
			}
		}
		sources.push(source);
	}
	return sources;
}
