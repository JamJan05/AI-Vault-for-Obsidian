/**
 * Finds where an indexed fragment sits inside the current text of its note, so a
 * source can open the note at the passage the model was given.
 *
 * Runs on the device only. The note may have changed since it was indexed, so
 * every step degrades to a looser match and finally to "not found".
 */

export interface TextRange {
	/** Offset of the first character. */
	start: number;
	/** Offset just past the last character. */
	end:   number;
	/** Zero-based line of `start`. */
	line:  number;
}

/** Shortest line worth searching for on its own; shorter ones match by accident. */
const MIN_LINE_LENGTH = 20;

function toRange(content: string, start: number, end: number): TextRange {
	let line = 0;
	for (let i = content.indexOf("\n"); i !== -1 && i < start; i = content.indexOf("\n", i + 1)) line++;
	return { start, end, line };
}

/** Collapses whitespace runs to one space and remembers where each character came from. */
function collapseWhitespace(text: string): { text: string; offsets: number[] } {
	let out = "";
	const offsets: number[] = [];
	let inSpace = false;

	for (let i = 0; i < text.length; i++) {
		if (/\s/.test(text[i])) {
			if (inSpace) continue;
			inSpace = true;
			out += " ";
		} else {
			inSpace = false;
			out += text[i];
		}
		offsets.push(i);
	}
	return { text: out, offsets };
}

export function locateChunk(content: string, chunk: string): TextRange | null {
	const needle = (chunk ?? "").trim();
	if (!content || !needle) return null;

	// 1. The fragment is still there word for word.
	const exact = content.indexOf(needle);
	if (exact !== -1) return toRange(content, exact, exact + needle.length);

	// 2. Same words, different spacing — chunking rejoins paragraphs with a blank line.
	const haystack = collapseWhitespace(content);
	const collapsed = collapseWhitespace(needle).text.trim();
	const loose = collapsed ? haystack.text.indexOf(collapsed) : -1;
	if (loose !== -1) {
		const start = haystack.offsets[loose];
		const end   = haystack.offsets[loose + collapsed.length - 1] + 1;
		return toRange(content, start, end);
	}

	// 3. The note was edited: settle for the longest line that survived.
	const lines = needle
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length >= MIN_LINE_LENGTH)
		.sort((a, b) => b.length - a.length);

	for (const line of lines) {
		const at = content.indexOf(line);
		if (at !== -1) return toRange(content, at, at + line.length);
	}

	return null;
}
