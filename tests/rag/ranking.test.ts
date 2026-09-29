/**
 * Pure RAG helpers. These decide which note fragments are put into a prompt and
 * sent to a model provider, so their behaviour is part of the privacy surface.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildTermFreq,
	chunkText,
	contentHash,
	cosineSim,
	dotProduct,
	tokenize,
	vectorNorm,
} from "../../src/utils";

describe("tokenize", () => {
	it("lowercases and drops punctuation", () => {
		assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
	});

	it("keeps accented characters", () => {
		const tokens = tokenize("zażółć gęślą jaźń");
		assert.ok(tokens.includes("zażółć"));
		assert.ok(tokens.includes("jaźń"));
	});

	it("drops stopwords and very short tokens", () => {
		const tokens = tokenize("the and a to notebook");
		assert.deepEqual(tokens, ["notebook"]);
	});

	it("returns an empty array for empty or punctuation-only input", () => {
		assert.deepEqual(tokenize(""), []);
		assert.deepEqual(tokenize("!!! ??? ..."), []);
	});
});

describe("buildTermFreq", () => {
	it("counts each token", () => {
		assert.deepEqual(buildTermFreq(["a", "b", "a"]), { a: 2, b: 1 });
	});

	it("returns an empty map for no tokens", () => {
		assert.deepEqual(buildTermFreq([]), {});
	});
});

describe("vector maths", () => {
	it("computes the dot product and norm", () => {
		assert.equal(dotProduct([1, 2, 3], [4, 5, 6]), 32);
		assert.equal(vectorNorm([3, 4]), 5);
	});

	it("returns 1 for identical directions and 0 for orthogonal ones", () => {
		assert.ok(Math.abs(cosineSim([1, 0], [2, 0]) - 1) < 1e-9);
		assert.equal(cosineSim([1, 0], [0, 1]), 0);
	});

	it("returns 0 instead of NaN for a zero vector", () => {
		assert.equal(cosineSim([0, 0], [1, 1]), 0);
		assert.equal(cosineSim([1, 1], [0, 0]), 0);
	});

	it("uses precomputed norms when supplied", () => {
		assert.ok(Math.abs(cosineSim([3, 4], [3, 4], 5, 5) - 1) < 1e-9);
	});
});

describe("chunkText", () => {
	it("never returns an empty array", () => {
		assert.ok(chunkText("").length >= 1);
		assert.ok(chunkText("short note").length >= 1);
	});

	it("splits on H1/H2 headings", () => {
		const alpha = "alpha ".repeat(60);
		const beta  = "beta ".repeat(60);
		const chunks = chunkText(`# One\n${alpha}\n\n## Two\n${beta}`);
		assert.equal(chunks.length, 2);
		assert.ok(chunks[0].startsWith("# One") && chunks[0].includes("alpha"));
		assert.ok(chunks[1].startsWith("## Two") && chunks[1].includes("beta"));
	});

	it("never leaves a heading on its own", () => {
		const body = "This section has enough text to stand on its own as a fragment. ".repeat(5);
		const note = `# Kosmos\n\n## Atmosfera\n${body}\n\n## Planety\n${body}`;
		const chunks = chunkText(note);

		assert.ok(chunks.length >= 2);
		for (const chunk of chunks) {
			assert.ok(chunk.includes("\n"), `heading-only fragment: ${chunk.slice(0, 40)}`);
			assert.ok(chunk.length >= 200, `fragment of ${chunk.length} chars`);
		}
		assert.ok(chunks[0].startsWith("# Kosmos"));
		assert.ok(chunks[0].includes("## Atmosfera"));
	});

	it("joins short sections instead of making tiny fragments", () => {
		const note = Array.from({ length: 12 }, (_v, i) => `## Point ${i}\nA short line about point ${i}.`).join("\n\n");
		for (const chunk of chunkText(note)) {
			assert.ok(chunk.length >= 200 || chunk === chunkText(note).at(-1), `fragment of ${chunk.length} chars`);
		}
	});

	it("keeps a short note as one fragment", () => {
		assert.deepEqual(chunkText("# Title\n\nOne line."), ["# Title\n\nOne line."]);
	});

	it("loses no text", () => {
		const body = "Sentence number one is here. ".repeat(20);
		const note = `# A\n\n## B\n${body}\n\n## C\nshort\n\n## D\n${body}\n\n## E\nend`;
		const joined = chunkText(note).join("\n");
		for (const marker of ["# A", "## B", "## C", "short", "## D", "## E", "end"]) {
			assert.ok(joined.includes(marker), marker);
		}
	});

	it("splits one huge paragraph that has no blank lines", () => {
		const wall = "word ".repeat(4000);
		const chunks = chunkText(wall, 1200, 150);
		assert.ok(chunks.length > 10);
		for (const chunk of chunks) assert.ok(chunk.length <= 1200 * 1.5, `fragment of ${chunk.length} chars`);
	});

	it("splits an oversized section into multiple chunks", () => {
		const long = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${"x".repeat(100)}`).join("\n\n");
		const chunks = chunkText(long, 500, 50);
		assert.ok(chunks.length > 1);
	});

	it("keeps every chunk within a reasonable multiple of the requested size", () => {
		const long = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${"x".repeat(100)}`).join("\n\n");
		for (const chunk of chunkText(long, 500, 50)) {
			assert.ok(chunk.length <= 500 * 3, `chunk of ${chunk.length} chars is far over the budget`);
		}
	});
});

describe("contentHash", () => {
	it("is stable for the same input", () => {
		assert.equal(contentHash("note body"), contentHash("note body"));
	});

	it("changes when the content changes", () => {
		assert.notEqual(contentHash("note body"), contentHash("note body!"));
	});

	it("handles an empty string", () => {
		assert.equal(typeof contentHash(""), "string");
	});
});
