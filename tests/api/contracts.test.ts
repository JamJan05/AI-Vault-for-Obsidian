import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	extractAnthropicText,
	extractOllamaContent,
	extractOpenAIChatText,
	extractOpenAIContent,
	extractOpenAIResponsesText,
	normalizeLocalBaseUrl,
	parseLocalModelList,
} from "../../src/api/contracts";

describe("normalizeLocalBaseUrl", () => {
	it("appends /v1 for OpenAI-compatible servers", () => {
		assert.equal(normalizeLocalBaseUrl("http://localhost:1234", "openai-compatible"), "http://localhost:1234/v1");
	});

	it("does not append /v1 twice", () => {
		assert.equal(normalizeLocalBaseUrl("http://localhost:1234/v1", "openai-compatible"), "http://localhost:1234/v1");
		assert.equal(normalizeLocalBaseUrl("http://localhost:1234/V1", "openai-compatible"), "http://localhost:1234/V1");
	});

	it("strips trailing slashes", () => {
		assert.equal(normalizeLocalBaseUrl("http://localhost:11434///", "ollama"), "http://localhost:11434");
		assert.equal(normalizeLocalBaseUrl("http://localhost:1234/v1/", "openai-compatible"), "http://localhost:1234/v1");
	});

	it("leaves the Ollama host untouched", () => {
		assert.equal(normalizeLocalBaseUrl("http://localhost:11434", "ollama"), "http://localhost:11434");
	});

	it("trims whitespace and tolerates empty input", () => {
		assert.equal(normalizeLocalBaseUrl("  http://localhost:11434  ", "ollama"), "http://localhost:11434");
		assert.equal(normalizeLocalBaseUrl("", "openai-compatible"), "");
		assert.equal(normalizeLocalBaseUrl("   ", "openai-compatible"), "");
		assert.equal(normalizeLocalBaseUrl(undefined as unknown as string, "ollama"), "");
	});
});

describe("parseLocalModelList — OpenAI-compatible", () => {
	it("extracts non-empty string ids", () => {
		const models = parseLocalModelList({ data: [{ id: "llama3" }, { id: "qwen" }] }, "openai-compatible");
		assert.deepEqual(models, ["llama3", "qwen"]);
	});

	it("drops entries whose id is not a usable string", () => {
		const models = parseLocalModelList(
			{ data: [{ id: "ok" }, { id: 42 }, { id: "" }, {}, { id: null }] },
			"openai-compatible",
		);
		assert.deepEqual(models, ["ok"]);
	});

	it("rejects a response that is not shaped like the contract", () => {
		for (const bad of [null, undefined, "string", 7, {}, { data: "nope" }, []]) {
			assert.throws(() => parseLocalModelList(bad, "openai-compatible"), /Invalid OpenAI-compatible response/);
		}
	});

	it("returns an empty list rather than throwing for an empty data array", () => {
		assert.deepEqual(parseLocalModelList({ data: [] }, "openai-compatible"), []);
	});
});

describe("parseLocalModelList — Ollama", () => {
	it("extracts non-empty names", () => {
		assert.deepEqual(parseLocalModelList({ models: [{ name: "llama3:8b" }] }, "ollama"), ["llama3:8b"]);
	});

	it("rejects a response that is not shaped like the contract", () => {
		for (const bad of [null, { models: {} }, { data: [] }, "x"]) {
			assert.throws(() => parseLocalModelList(bad, "ollama"), /Invalid Ollama response/);
		}
	});
});

describe("extractOpenAIContent (Local API chat)", () => {
	it("returns trimmed content", () => {
		assert.equal(extractOpenAIContent({ choices: [{ message: { content: "  hi  " } }] }), "hi");
	});

	it("returns an empty string when content is missing or mistyped", () => {
		assert.equal(extractOpenAIContent({ choices: [] }), "");
		assert.equal(extractOpenAIContent({ choices: [{ message: {} }] }), "");
		assert.equal(extractOpenAIContent({ choices: [{ message: { content: 5 } }] }), "");
	});

	it("throws when the envelope is wrong", () => {
		for (const bad of [null, undefined, "x", {}, { choices: "no" }]) {
			assert.throws(() => extractOpenAIContent(bad), /Invalid OpenAI-compatible response/);
		}
	});
});

describe("extractOllamaContent", () => {
	it("returns trimmed content", () => {
		assert.equal(extractOllamaContent({ message: { content: " hello " } }), "hello");
	});

	it("throws when message is missing or not an object", () => {
		for (const bad of [null, {}, { message: "text" }, { message: 1 }]) {
			assert.throws(() => extractOllamaContent(bad), /Invalid Ollama response/);
		}
	});

	it("returns an empty string when content is not a string", () => {
		assert.equal(extractOllamaContent({ message: { content: 42 } }), "");
	});
});

describe("extractOpenAIChatText", () => {
	it("reads choices[0].message.content", () => {
		assert.equal(extractOpenAIChatText({ choices: [{ message: { content: "text" } }] }), "text");
	});

	it("returns null for every malformed shape instead of throwing", () => {
		for (const bad of [{}, { choices: null }, { choices: [] }, { choices: [null] }, { choices: [{}] }, { choices: [{ message: { content: 1 } }] }]) {
			assert.equal(extractOpenAIChatText(bad as Record<string, unknown>), null);
		}
	});
});

describe("extractOpenAIResponsesText", () => {
	it("concatenates output_text parts", () => {
		const text = extractOpenAIResponsesText({
			output: [
				{ content: [{ type: "output_text", text: "a" }, { type: "reasoning", text: "IGNORED" }] },
				{ content: [{ type: "output_text", text: "b" }] },
			],
		});
		assert.equal(text, "ab");
	});

	it("ignores non-text blocks entirely", () => {
		const text = extractOpenAIResponsesText({
			output: [{ content: [{ type: "reasoning", text: "hidden" }] }],
		});
		assert.equal(text, null);
	});

	it("returns null for malformed input", () => {
		for (const bad of [{}, { output: "x" }, { output: [null] }, { output: [{ content: "x" }] }]) {
			assert.equal(extractOpenAIResponsesText(bad as Record<string, unknown>), null);
		}
	});
});

describe("extractAnthropicText", () => {
	it("concatenates text blocks and skips the rest", () => {
		const text = extractAnthropicText({
			content: [
				{ type: "text", text: "one " },
				{ type: "tool_use", input: { q: "IGNORED" } },
				{ type: "text", text: "two" },
			],
		});
		assert.equal(text, "one two");
	});

	it("returns null when there is no text block", () => {
		assert.equal(extractAnthropicText({ content: [{ type: "tool_use" }] }), null);
		assert.equal(extractAnthropicText({ content: [] }), null);
	});

	it("returns null for malformed input", () => {
		for (const bad of [{}, { content: null }, { content: "text" }]) {
			assert.equal(extractAnthropicText(bad as Record<string, unknown>), null);
		}
	});

	it("ignores a text block whose text is not a string", () => {
		assert.equal(extractAnthropicText({ content: [{ type: "text", text: 5 }] }), null);
	});
});
