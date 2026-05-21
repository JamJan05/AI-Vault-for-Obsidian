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
	fileMap?: Map<string, TFile>,
): Promise<ResolvedNote[]> {
	if (visited.has(file.path)) return [];
	visited.add(file.path);

	// Build the map once — basename → TFile, path → TFile
	if (!fileMap) {
		fileMap = new Map<string, TFile>();
		for (const f of app.vault.getMarkdownFiles()) {
			fileMap.set(f.basename, f);
			fileMap.set(f.path, f);
			fileMap.set(f.path.replace(/\.md$/, ""), f);
		}
	}

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
			const linked   =
				fileMap.get(linkName) ??
				fileMap.get(linkName + ".md");

			if (linked && !visited.has(linked.path)) {
				const sub = await resolveNoteWithLinks(app, linked, depth - 1, visited, fileMap);
				results.push(...sub);
			}
		}
	} catch (e) {
		console.warn("[AI-Vault] resolveNoteWithLinks failed:", file?.path, (e as Error)?.message);
	}

	return results;
}
