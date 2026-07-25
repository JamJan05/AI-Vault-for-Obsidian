import type { App, TFile } from "obsidian";

export interface ResolvedNote {
	file:    TFile;
	content: string;
}

/**
 * Recursively follows [[wiki-links]] in a note.
 * Returns an array of {file, content} for the main note and linked notes (up to `depth`).
 *
 * `isIgnored` filters linked notes only — the note passed in was chosen explicitly by
 * the user, while links are followed implicitly and must respect the RAG ignore list.
 */
export async function resolveNoteWithLinks(
	app:     App,
	file:    TFile,
	depth    = 1,
	visited  = new Set<string>(),
	isIgnored: (path: string) => boolean = () => false,
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

			if (linked && !visited.has(linked.path) && !isIgnored(linked.path)) {
				const sub = await resolveNoteWithLinks(app, linked, depth - 1, visited, isIgnored);
				results.push(...sub);
			}
		}
	} catch (e) {
		console.warn("[AI-Vault] resolveNoteWithLinks failed:", file?.path, (e as Error)?.message);
	}

	return results;
}
