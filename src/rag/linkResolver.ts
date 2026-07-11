import type { App, TFile } from "obsidian";

export interface ResolvedNote {
	file:    TFile;
	content: string;
}

/**
 * Recursively follows [[wiki-links]] in a note.
 * Returns an array of {file, content} for the main note and linked notes (up to `depth`).
 */
export async function resolveNoteWithLinks(
	app:     App,
	file:    TFile,
	depth    = 1,
	visited  = new Set<string>(),
): Promise<ResolvedNote[]> {
	if (visited.has(file.path)) return [];
	visited.add(file.path);

	const results: ResolvedNote[] = [];

	try {
		const content = await app.vault.cachedRead(file);
		results.push({ file, content });

		if (depth <= 0) return results;

		// Find [[links]] and [[alias|links]]
		const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
		let match: RegExpExecArray | null;

		while ((match = linkRegex.exec(content)) !== null) {
			const linkName = match[1].trim();
			const linked = app.metadataCache.getFirstLinkpathDest(linkName, file.path);

			if (linked && !visited.has(linked.path)) {
				const sub = await resolveNoteWithLinks(app, linked, depth - 1, visited);
				results.push(...sub);
			}
		}
	} catch (e) {
		console.warn("[AI-Vault] resolveNoteWithLinks failed:", file?.path, (e as Error)?.message);
	}

	return results;
}
