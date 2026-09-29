import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { locateChunk } from "../../src/rag/locate";
import { chunkText } from "../../src/utils";

const NOTE = [
	"# Trip to Gdańsk",
	"",
	"We arrived on Friday evening and walked along the Motława.",
	"",
	"## Food",
	"",
	"The pierogi near the crane were the best we had all week.",
	"",
	"",
	"Dessert was a slice of sernik with far too much whipped cream.",
].join("\n");

describe("locateChunk", () => {
	it("finds a fragment that is still there word for word", () => {
		const chunk = "The pierogi near the crane were the best we had all week.";
		const range = locateChunk(NOTE, chunk);
		assert.ok(range);
		assert.equal(NOTE.slice(range.start, range.end), chunk);
		assert.equal(range.line, 6);
	});

	it("reports line 0 for a match at the very beginning", () => {
		const range = locateChunk(NOTE, "# Trip to Gdańsk");
		assert.deepEqual(range, { start: 0, end: 16, line: 0 });
	});

	it("finds a fragment whose paragraphs were rejoined with different spacing", () => {
		const chunk = "The pierogi near the crane were the best we had all week.\n\nDessert was a slice of sernik with far too much whipped cream.";
		assert.equal(NOTE.includes(chunk), false);

		const range = locateChunk(NOTE, chunk);
		assert.ok(range);
		assert.equal(range.line, 6);
		assert.ok(NOTE.slice(range.start, range.end).startsWith("The pierogi"));
		assert.ok(NOTE.slice(range.start, range.end).endsWith("whipped cream."));
	});

	it("falls back to the longest surviving line when the note was edited", () => {
		const chunk = "## Food\n\nThe pierogi near the crane were the best we had all week.\n\nThis sentence was deleted from the note afterwards.";
		const range = locateChunk(NOTE, chunk);
		assert.ok(range);
		assert.equal(NOTE.slice(range.start, range.end), "The pierogi near the crane were the best we had all week.");
	});

	it("does not match on a short line alone", () => {
		assert.equal(locateChunk(NOTE, "## Food\n\nNothing else here matches the note at all, truly."), null);
	});

	it("returns null when nothing matches or the input is empty", () => {
		assert.equal(locateChunk(NOTE, "A fragment from a completely different note."), null);
		assert.equal(locateChunk(NOTE, ""), null);
		assert.equal(locateChunk(NOTE, "   \n  "), null);
		assert.equal(locateChunk("", "anything long enough to search for"), null);
		assert.equal(locateChunk(NOTE, undefined as unknown as string), null);
	});

	it("always returns a range inside the note", () => {
		for (const chunk of ["Food", "whipped cream.", NOTE, NOTE + "\n"]) {
			const range = locateChunk(NOTE, chunk);
			if (!range) continue;
			assert.ok(range.start >= 0 && range.start < range.end && range.end <= NOTE.length, chunk);
		}
	});

	it("locates every fragment the indexer produces from a long note", () => {
		const paragraphs = Array.from({ length: 60 }, (_v, i) =>
			`Paragraph ${i} talks about topic number ${i} at some length, so that the section grows past one chunk.`);
		const long = "# Long note\n\n" + paragraphs.join("\n\n\n");

		const chunks = chunkText(long);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) {
			const range = locateChunk(long, chunk);
			assert.ok(range, chunk.slice(0, 40));
		}
	});
});
