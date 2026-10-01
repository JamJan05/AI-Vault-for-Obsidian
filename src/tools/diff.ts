/**
 * Line diff for the change confirmation dialog.
 *
 * Pure and dependency-free. The user approves a change from what this returns,
 * so it is unit tested as written.
 */

export type DiffKind = "same" | "removed" | "added";

export interface DiffLine {
	kind: DiffKind;
	text: string;
}

/** Above this many cell comparisons the diff falls back to "all removed, all added". */
const MAX_CELLS = 400_000;

/**
 * A carriage return stays part of its line, so a change of line endings is a
 * changed line and never hides among the unchanged ones.
 */
function splitLines(text: string): string[] {
	return text === "" ? [] : text.split("\n");
}

/** Lines of `before` and `after`, marked as kept, removed or added, in reading order. */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = splitLines(before);
	const b = splitLines(after);

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;

	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

	const head: DiffLine[] = a.slice(0, start).map(text => ({ kind: "same", text }));
	const tail: DiffLine[] = a.slice(endA).map(text => ({ kind: "same", text }));

	return [...head, ...diffMiddle(a.slice(start, endA), b.slice(start, endB)), ...tail];
}

export type DiffRow =
	| (DiffLine & { line: number | null })
	| { kind: "gap"; skipped: number };

/**
 * Keeps the changed lines with `context` unchanged lines around them and folds
 * the rest into gaps. `line` is the line number in the new text, or null for a
 * removed line.
 */
export function collapseDiff(lines: DiffLine[], context = 3): DiffRow[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((line, index) => {
		if (line.kind === "same") return;
		const from = Math.max(0, index - context);
		const to   = Math.min(lines.length - 1, index + context);
		for (let i = from; i <= to; i++) keep[i] = true;
	});

	const rows: DiffRow[] = [];
	let lineNo  = 0;
	let skipped = 0;
	lines.forEach((line, index) => {
		if (line.kind !== "removed") lineNo++;
		if (!keep[index]) { skipped++; return; }
		if (skipped) { rows.push({ kind: "gap", skipped }); skipped = 0; }
		rows.push({ ...line, line: line.kind === "removed" ? null : lineNo });
	});
	if (skipped) rows.push({ kind: "gap", skipped });
	return rows;
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
	const removedAll = (): DiffLine[] => a.map(text => ({ kind: "removed", text }));
	const addedAll   = (): DiffLine[] => b.map(text => ({ kind: "added", text }));

	if (!a.length || !b.length || a.length * b.length > MAX_CELLS) {
		return [...removedAll(), ...addedAll()];
	}

	// Longest common subsequence, filled from the end so the walk below reads forward.
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] = a[i] === b[j]
				? table[(i + 1) * width + j + 1] + 1
				: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}

	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			lines.push({ kind: "same", text: a[i] });
			i++; j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			lines.push({ kind: "removed", text: a[i++] });
		} else {
			lines.push({ kind: "added", text: b[j++] });
		}
	}
	while (i < a.length) lines.push({ kind: "removed", text: a[i++] });
	while (j < b.length) lines.push({ kind: "added", text: b[j++] });
	return lines;
}
