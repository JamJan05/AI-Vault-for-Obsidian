/**
 * Notes the user marked for writing.
 *
 * The user names a note in a message as `#Name` or `#Folder/Name`. A name with
 * spaces is written with hyphens (`#My-note`) or in brackets (`#[[My note]]`).
 * `.md` or `.canvas` may be added to tell a note from a canvas of the same name.
 * Only notes marked this way may be changed, so text that misleads the model
 * cannot send its changes anywhere else: the list comes from what the user
 * typed, never from a note, a web page or a reply.
 *
 * Pure string logic, no Obsidian imports, so it is unit tested as written.
 */

import type { NoteChangeKind } from "./noteTools";

export interface WriteTargets {
	/** Existing notes and canvases that may be changed, as vault-relative paths. */
	paths:     string[];
	/** Marks that match no file: a note or canvas with this name (or path) may be created. Lowercase. */
	newNames:  string[];
	/** Marks that match several files. None of them may be changed until the mark is more exact. */
	ambiguous: string[];
}

/** `#[[Name]]`, or `#name` up to the next space. Must start the text or follow whitespace. */
const MARK = /(?:^|\s)#(?:\[\[([^\]\n]+)\]\]|([^\s#[\]]+))/g;

const EXTENSION = /\.(md|canvas)$/i;

/** A name or path split into what is compared and the extension, if one was given. */
interface Key {
	/** Lowercase, without extension, spaces written as hyphens. */
	name: string;
	/** "md", "canvas", or "" when none was given. */
	ext:  string;
}

function toKey(value: string): Key {
	const lower = value.toLowerCase();
	const ext   = EXTENSION.exec(lower)?.[1] ?? "";
	return {
		// A hyphen in a mark stands for a space as well, so both are folded to a hyphen.
		name: lower.replace(EXTENSION, "").replace(/\s+/g, "-"),
		ext,
	};
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function normalizeMark(raw: string, bracketed: boolean): string {
	let name = raw.trim();
	if (bracketed) {
		// A wikilink may carry a heading or an alias; only the note is meant.
		name = name.split("|")[0].split("#")[0].trim();
	} else {
		name = name.replace(/[.,;:!?)]+$/, "");
	}
	return name.replace(/^\/+/, "").toLowerCase();
}

/** The names marked in one message, lowercase, in order of first appearance. */
export function parseNoteMarks(text: string): string[] {
	const marks: string[] = [];
	for (const match of (text ?? "").matchAll(MARK)) {
		const name = normalizeMark(match[1] ?? match[2] ?? "", match[1] !== undefined);
		if (name && !marks.includes(name)) marks.push(name);
	}
	return marks;
}

/** True when a mark names this path: same name, and the same extension if the mark gave one. */
function matches(mark: Key, path: Key): boolean {
	if (mark.ext && mark.ext !== path.ext) return false;
	// A bare name means the file with that name, wherever it is — so a file in
	// the vault root does not win over one of the same name in a folder. A mark
	// with a folder is an exact path.
	return mark.name.includes("/") ? mark.name === path.name : mark.name === basename(path.name);
}

/**
 * Resolves marks against the files of the vault.
 * @param marks names from parseNoteMarks, taken only from text the user typed —
 *              never from model output or note content
 * @param paths vault-relative paths of the notes and canvases that may be used at all
 */
export function resolveWriteTargets(marks: string[], paths: string[]): WriteTargets {
	const targets: WriteTargets = { paths: [], newNames: [], ambiguous: [] };
	const files = paths.map(path => ({ path, key: toKey(path) }));

	for (const mark of new Set(marks)) {
		const key   = toKey(mark);
		const found = files.filter(file => matches(key, file.key));

		if (found.length === 1) {
			if (!targets.paths.includes(found[0].path)) targets.paths.push(found[0].path);
		} else if (found.length > 1) {
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

	const key = toKey(path);
	return targets.newNames.some(name => matches(toKey(name), key));
}
