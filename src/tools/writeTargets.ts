/**
 * Notes the user marked for writing.
 *
 * The user names a note in a message as `#Name`, `#Folder/Name` or, when the name
 * has spaces, `#[[Name with spaces]]`. Only notes marked this way may be changed,
 * so text that misleads the model cannot send its changes anywhere else: the list
 * comes from what the user typed, never from a note, a web page or a reply.
 *
 * Pure string logic, no Obsidian imports, so it is unit tested as written.
 */

import type { NoteChangeKind } from "./noteTools";

export interface WriteTargets {
	/** Existing notes that may be changed, as vault-relative paths. */
	paths:     string[];
	/** Marks that match no note: a note with this name (or path) may be created. Lowercase, no extension. */
	newNames:  string[];
	/** Marks that match several notes. None of them may be changed until the mark names a folder. */
	ambiguous: string[];
}

/** `#[[Name]]`, or `#name` up to the next space. Must start the text or follow whitespace. */
const MARK = /(?:^|\s)#(?:\[\[([^\]\n]+)\]\]|([^\s#[\]]+))/g;

function stripExtension(path: string): string {
	return path.replace(/\.md$/i, "");
}

function normalizeMark(raw: string, bracketed: boolean): string {
	let name = raw.trim();
	if (bracketed) {
		// A wikilink may carry a heading or an alias; only the note is meant.
		name = name.split("|")[0].split("#")[0].trim();
	} else {
		name = name.replace(/[.,;:!?)]+$/, "");
	}
	return stripExtension(name.replace(/^\/+/, "")).toLowerCase();
}

/** The note names marked in one message, lowercase and without extension, in order. */
export function parseNoteMarks(text: string): string[] {
	const marks: string[] = [];
	for (const match of (text ?? "").matchAll(MARK)) {
		const name = normalizeMark(match[1] ?? match[2] ?? "", match[1] !== undefined);
		if (name && !marks.includes(name)) marks.push(name);
	}
	return marks;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Resolves marks against the notes of the vault.
 * @param marks     names from parseNoteMarks, taken only from text the user typed —
 *                  never from model output or note content
 * @param notePaths vault-relative paths of the notes that may be used at all
 */
export function resolveWriteTargets(marks: string[], notePaths: string[]): WriteTargets {
	const targets: WriteTargets = { paths: [], newNames: [], ambiguous: [] };
	const notes = notePaths.map(path => ({ path, key: stripExtension(path).toLowerCase() }));

	for (const mark of new Set(marks)) {
		// A bare name means the note with that name, wherever it is — so a note in
		// the vault root does not win over one of the same name in a folder. A mark
		// with a folder is an exact path.
		const matches = mark.includes("/")
			? notes.filter(note => note.key === mark)
			: notes.filter(note => basename(note.key) === mark);

		if (matches.length === 1) {
			if (!targets.paths.includes(matches[0].path)) targets.paths.push(matches[0].path);
		} else if (matches.length > 1) {
			targets.ambiguous.push(mark);
		} else {
			targets.newNames.push(mark);
		}
	}
	return targets;
}

/** True when the user's marks allow this change. */
export function mayWrite(targets: WriteTargets, path: string, kind: NoteChangeKind): boolean {
	if (kind !== "create") return targets.paths.includes(path);

	const key = stripExtension(path).toLowerCase();
	return targets.newNames.some(name =>
		name === key || (!name.includes("/") && name === basename(key)));
}
