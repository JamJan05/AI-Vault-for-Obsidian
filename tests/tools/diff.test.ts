/**
 * The user approves a change from this diff. If a changed line were missing
 * from it, they would approve something they never saw.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collapseDiff, diffLines } from "../../src/tools/diff";
import type { DiffLine } from "../../src/tools/diff";

const render = (lines: DiffLine[]): string[] =>
	lines.map(line => `${line.kind === "same" ? " " : line.kind === "removed" ? "-" : "+"}${line.text}`);

/** Rebuilds both texts from a diff, to prove that nothing was dropped. */
function rebuild(lines: DiffLine[]): { before: string; after: string } {
	return {
		before: lines.filter(l => l.kind !== "added").map(l => l.text).join("\n"),
		after:  lines.filter(l => l.kind !== "removed").map(l => l.text).join("\n"),
	};
}

describe("diffLines", () => {
	it("marks a replaced line", () => {
		assert.deepEqual(render(diffLines("a\nb\nc", "a\nB\nc")), [" a", "-b", "+B", " c"]);
	});

	it("marks added and removed lines", () => {
		assert.deepEqual(render(diffLines("a\nc", "a\nb\nc")), [" a", "+b", " c"]);
		assert.deepEqual(render(diffLines("a\nb\nc", "a\nc")), [" a", "-b", " c"]);
	});

	it("shows a new note as all added and an emptied note as all removed", () => {
		assert.deepEqual(render(diffLines("", "x\ny")), ["+x", "+y"]);
		assert.deepEqual(render(diffLines("x\ny", "")), ["-x", "-y"]);
		assert.deepEqual(diffLines("", ""), []);
	});

	it("returns only unchanged lines for identical texts", () => {
		assert.ok(diffLines("a\nb", "a\nb").every(line => line.kind === "same"));
	});

	it("keeps several separate changes apart", () => {
		const before = "1\n2\n3\n4\n5\n6";
		const after  = "1\nB\n3\n4\nE\n6\n7";
		assert.deepEqual(render(diffLines(before, after)), [" 1", "-2", "+B", " 3", " 4", "-5", "+E", " 6", "+7"]);
	});

	it("never loses a line, whatever the input", () => {
		const cases: Array<[string, string]> = [
			["a\nb\nc\nd", "d\nc\nb\na"],
			["x\n\n\ny", "x\ny\n\n"],
			["same\nsame\nsame", "same\nsame"],
			["one", "two"],
			["a\r\nb", "a\r\nc"],
			["a\r\nb\r\n", "a\nb\n"],
		];
		for (const [before, after] of cases) {
			assert.deepEqual(rebuild(diffLines(before, after)), { before, after });
		}
	});

	it("shows a change of line endings as a changed line", () => {
		const lines = diffLines("a\r\nb", "a\nb");
		assert.deepEqual(render(lines), ["-a\r", "+a", " b"]);
	});

	it("falls back to removed-then-added for very large changes, still complete", () => {
		const before = Array.from({ length: 900 }, (_, i) => `old ${i}`).join("\n");
		const after  = Array.from({ length: 900 }, (_, i) => `new ${i}`).join("\n");
		const lines  = diffLines(before, after);
		assert.equal(lines.length, 1800);
		assert.deepEqual(rebuild(lines), { before, after });
	});
});

describe("collapseDiff", () => {
	const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
	const after  = before.replace("line 10", "LINE TEN");

	it("keeps every changed line and folds distant unchanged lines", () => {
		const rows = collapseDiff(diffLines(before, after), 2);
		assert.deepEqual(rows, [
			{ kind: "gap", skipped: 7 },
			{ kind: "same", text: "line 8", line: 8 },
			{ kind: "same", text: "line 9", line: 9 },
			{ kind: "removed", text: "line 10", line: null },
			{ kind: "added", text: "LINE TEN", line: 10 },
			{ kind: "same", text: "line 11", line: 11 },
			{ kind: "same", text: "line 12", line: 12 },
			{ kind: "gap", skipped: 8 },
		]);
	});

	it("shows every changed line of the full diff", () => {
		const lines   = diffLines("a\nb\nc\nd\ne\nf\ng\nh\ni", "A\nb\nc\nd\ne\nf\ng\nh\nI");
		const changed = lines.filter(line => line.kind !== "same").length;
		const shown   = collapseDiff(lines, 1).filter(row => row.kind === "removed" || row.kind === "added").length;
		assert.equal(shown, changed);
	});

	it("is one gap when nothing changed", () => {
		assert.deepEqual(collapseDiff(diffLines("a\nb", "a\nb")), [{ kind: "gap", skipped: 2 }]);
	});
});
