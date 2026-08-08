/**
 * Pure RAG helpers. These decide which note fragments are put into a prompt and
 * sent to a model provider, so their behaviour is part of the privacy surface.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	bm25Score,
	buildTermFreq,
	chunkText,
	contentHash,
	cosineSim,
	dotProduct,
	sanitizeUrl,
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

describe("bm25Score", () => {
	it("scores a document containing the query terms above one that does not", () => {
		const withTerm = bm25Score(["vault"], { vault: 3 }, 10, 10);
		const without = bm25Score(["vault"], { other: 3 }, 10, 10);
		assert.ok(withTerm > without);
		assert.equal(without, 0);
	});

	it("is finite for a zero-length document and a zero average", () => {
		assert.ok(Number.isFinite(bm25Score(["x"], {}, 0, 0)));
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
		const chunks = chunkText("# One\nalpha\n\n## Two\nbeta");
		assert.ok(chunks.length >= 2);
		assert.ok(chunks.some(c => c.includes("alpha")));
		assert.ok(chunks.some(c => c.includes("beta")));
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

describe("sanitizeUrl", () => {
	it("allows http, https and mailto", () => {
		assert.equal(sanitizeUrl("https://example.com"), "https://example.com");
		assert.equal(sanitizeUrl("http://example.com"), "http://example.com");
		assert.equal(sanitizeUrl("mailto:a@example.com"), "mailto:a@example.com");
	});

	it("blocks script-bearing and data schemes", () => {
		assert.equal(sanitizeUrl("javascript:alert(1)"), "#");
		assert.equal(sanitizeUrl("JavaScript:alert(1)"), "#");
		assert.equal(sanitizeUrl("data:text/html,<script>"), "#");
		assert.equal(sanitizeUrl("vbscript:msgbox"), "#");
		assert.equal(sanitizeUrl("file:///etc/passwd"), "#");
	});

	it("blocks non-string input", () => {
		assert.equal(sanitizeUrl(undefined as unknown as string), "#");
	});
});
