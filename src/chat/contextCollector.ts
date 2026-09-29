import type { App, TFile } from "obsidian";
import { RAG_TOP_K } from "../constants";
import { parseCanvasToText } from "../rag/canvasParser";
import { resolveNoteWithLinks } from "../rag/linkResolver";
import { toMessageSource } from "../rag/sources";
import type { RAGEngine } from "../rag/RAGEngine";
import type { MessageSource } from "../types";
import type { NoteExcerpt } from "./systemPrompt";

export interface CollectedContext {
	attached:  NoteExcerpt[];
	retrieved: NoteExcerpt[];
	/** What is shown under the answer and saved with it. */
	sources:   MessageSource[];
}

interface CollectInput {
	app:         App;
	rag:         RAGEngine;
	ragEnabled:  boolean;
	manualNotes: TFile[];
	userText:    string;
}

/**
 * Gathers the note text that will go into the prompt.
 *
 * Notes the user attached are an explicit choice and are always included.
 * Everything reached implicitly — wikilinks and RAG hits — is filtered through
 * the ignored RAG paths, here, at the last point before the text leaves the device.
 */
export async function collectContext(input: CollectInput): Promise<CollectedContext> {
	const { app, rag, manualNotes } = input;
	const context: CollectedContext = { attached: [], retrieved: [], sources: [] };
	const isIgnored = (path: string): boolean => rag.isIgnoredPath(path);

	if (manualNotes.length) {
		const notes: { file: TFile; content: string }[] = [];
		const visited = new Set<string>();

		for (const file of manualNotes) {
			if (file.extension === "canvas") {
				try {
					const raw = await app.vault.cachedRead(file);
					notes.push({ file, content: parseCanvasToText(raw, file.basename) });
				} catch (e) {
					console.warn("[AI-Vault] canvas read failed:", file.path, (e as Error)?.message);
				}
			} else {
				notes.push(...await resolveNoteWithLinks(app, file, 1, visited, isIgnored));
			}
		}

		if (notes.length) {
			context.attached = notes.map(n => ({ title: n.file.basename, text: n.content }));
			context.sources.push(...manualNotes.map(f => toMessageSource(f.basename, f.path)));
			const linked = notes.filter(n => !manualNotes.some(f => f.path === n.file.path));
			context.sources.push(...linked.map(n => toMessageSource(`↳ ${n.file.basename}`, n.file.path)));
		}
	}

	if (input.ragEnabled && rag.indexed && input.userText) {
		const results = await rag.search(input.userText, RAG_TOP_K);
		// The engine already filters; this also keeps the sources in sync with the prompt.
		const usable = results.filter(r =>
			!manualNotes.some(f => f.path === r.path) && !isIgnored(r.path));

		context.retrieved = usable.map(r => ({ title: r.basename, text: r.chunk }));
		context.sources.push(...usable.map(r => toMessageSource(r.basename, r.path, r.chunk)));
	}

	return context;
}
