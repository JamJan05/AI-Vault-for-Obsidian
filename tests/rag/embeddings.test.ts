/**
 * The embeddings gate decides whether note text may be sent to OpenAI, so it is
 * the most privacy-sensitive predicate in the plugin.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	EMBEDDINGS_MODEL,
	EMBEDDINGS_URL,
	EMBEDDING_MAX_CHARS,
	buildEmbeddingsBody,
	canUseEmbeddings,
	parseEmbeddingsResponse,
} from "../../src/rag/embeddings";
import { DEFAULT_SETTINGS } from "../../src/settings";

describe("canUseEmbeddings", () => {
	it("is off by default, even with an OpenAI key", () => {
		assert.equal(DEFAULT_SETTINGS.ragEmbeddingsEnabled, false);
		assert.equal(canUseEmbeddings({ ...DEFAULT_SETTINGS, apiKey: "sk-test" }), false);
	});

	it("needs consent, RAG and a key — all three", () => {
		assert.equal(canUseEmbeddings({ ragEmbeddingsEnabled: true, ragEnabled: true, apiKey: "sk-test" }), true);
		assert.equal(canUseEmbeddings({ ragEmbeddingsEnabled: false, ragEnabled: true, apiKey: "sk-test" }), false);
		assert.equal(canUseEmbeddings({ ragEmbeddingsEnabled: true, ragEnabled: false, apiKey: "sk-test" }), false);
		assert.equal(canUseEmbeddings({ ragEmbeddingsEnabled: true, ragEnabled: true, apiKey: "" }), false);
		assert.equal(canUseEmbeddings({ ragEmbeddingsEnabled: true, ragEnabled: true, apiKey: "   " }), false);
	});

	it("treats a missing or mistyped consent value as no consent", () => {
		for (const value of [undefined, null, "true", 1, {}, "yes"]) {
			assert.equal(
				canUseEmbeddings({
					ragEmbeddingsEnabled: value as unknown as boolean,
					ragEnabled: true,
					apiKey: "sk-test",
				}),
				false,
				String(value),
			);
		}
	});

	it("treats a missing or mistyped key as no key", () => {
		for (const value of [undefined, null, 42, {}]) {
			assert.equal(
				canUseEmbeddings({
					ragEmbeddingsEnabled: true,
					ragEnabled: true,
					apiKey: value as unknown as string,
				}),
				false,
			);
		}
	});

	it("does not depend on which chat provider is selected", () => {
		for (const provider of ["openai", "anthropic", "local"] as const) {
			const settings = { ...DEFAULT_SETTINGS, provider, apiKey: "sk-test" };
			assert.equal(canUseEmbeddings(settings), false, provider);
			assert.equal(canUseEmbeddings({ ...settings, ragEmbeddingsEnabled: true }), true, provider);
		}
	});
});

describe("buildEmbeddingsBody", () => {
	it("targets the disclosed host over https", () => {
		const url = new URL(EMBEDDINGS_URL);
		assert.equal(url.protocol, "https:");
		assert.equal(url.hostname, "api.openai.com");
		assert.equal(url.pathname, "/v1/embeddings");
	});

	it("sends the model and the texts, and nothing else", () => {
		const body = buildEmbeddingsBody(["one", "two"]);
		assert.deepEqual(body, { model: EMBEDDINGS_MODEL, input: ["one", "two"] });
	});

	it("truncates each text to the documented limit", () => {
		const body = buildEmbeddingsBody(["x".repeat(EMBEDDING_MAX_CHARS + 500), "short"]);
		assert.equal(body.input[0].length, EMBEDDING_MAX_CHARS);
		assert.equal(body.input[1], "short");
	});
});

describe("parseEmbeddingsResponse", () => {
	it("returns the vectors in input order", () => {
		const vectors = parseEmbeddingsResponse({
			data: [
				{ index: 1, embedding: [0.3, 0.4] },
				{ index: 0, embedding: [0.1, 0.2] },
			],
		}, 2);
		assert.deepEqual(vectors, [[0.1, 0.2], [0.3, 0.4]]);
	});

	it("falls back to the position when no index is given", () => {
		const vectors = parseEmbeddingsResponse({ data: [{ embedding: [1] }, { embedding: [2] }] }, 2);
		assert.deepEqual(vectors, [[1], [2]]);
	});

	it("rejects a response with the wrong number of vectors", () => {
		assert.throws(() => parseEmbeddingsResponse({ data: [{ embedding: [1] }] }, 2), /Expected 2 vectors, got 1/);
		assert.throws(() => parseEmbeddingsResponse({ data: [] }, 1), /Expected 1 vectors, got 0/);
	});

	it("rejects an envelope that is not shaped like the contract", () => {
		for (const bad of [null, undefined, "text", 7, [], {}, { data: "x" }, { data: {} }]) {
			assert.throws(() => parseEmbeddingsResponse(bad, 1), /Invalid embeddings response/);
		}
	});

	it("rejects a vector that is missing, empty or not numeric", () => {
		for (const embedding of [undefined, null, "text", [], [1, "2"], [1, null], [NaN], [Infinity]]) {
			assert.throws(
				() => parseEmbeddingsResponse({ data: [{ index: 0, embedding }] }, 1),
				/missing or not numeric/,
			);
		}
	});

	it("rejects duplicate or out-of-range indexes", () => {
		const v = [1];
		assert.throws(() => parseEmbeddingsResponse({ data: [{ index: 0, embedding: v }, { index: 0, embedding: v }] }, 2), /inconsistent/);
		assert.throws(() => parseEmbeddingsResponse({ data: [{ index: 5, embedding: v }] }, 1), /inconsistent/);
		assert.throws(() => parseEmbeddingsResponse({ data: [{ index: -1, embedding: v }] }, 1), /inconsistent/);
		assert.throws(() => parseEmbeddingsResponse({ data: [{ index: 0.5, embedding: v }] }, 1), /inconsistent/);
	});

	it("never echoes response content in its error messages", () => {
		try {
			parseEmbeddingsResponse({ data: [{ index: 0, embedding: "SECRET-NOTE-TEXT" }] }, 1);
			assert.fail("expected a throw");
		} catch (e) {
			assert.equal((e as Error).message.includes("SECRET-NOTE-TEXT"), false);
		}
	});
});
