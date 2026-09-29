import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	extractAnthropicText,
	extractOllamaContent,
	extractOpenAIChatText,
	extractOpenAIContent,
	extractOpenAIResponsesCitations,
	extractOpenAIResponsesText,
	formatCitations,
	normalizeLocalBaseUrl,
	parseLocalModelList,
	readAnthropicContent,
	readAnthropicStopReason,
	readServedModel,
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

describe("extractOpenAIResponsesCitations", () => {
	const withAnnotations = (annotations: unknown): Record<string, unknown> => ({
		output: [{ content: [{ type: "output_text", text: "answer", annotations }] }],
	});

	it("collects url citations in order and drops duplicates", () => {
		const citations = extractOpenAIResponsesCitations(withAnnotations([
			{ type: "url_citation", url: "https://a.example/page", title: "A" },
			{ type: "url_citation", url: "https://b.example/", title: "B" },
			{ type: "url_citation", url: "https://a.example/page", title: "A again" },
		]));
		assert.deepEqual(citations, [
			{ url: "https://a.example/page", title: "A" },
			{ url: "https://b.example/", title: "B" },
		]);
	});

	it("refuses every scheme except http and https", () => {
		const citations = extractOpenAIResponsesCitations(withAnnotations([
			{ type: "url_citation", url: "javascript:alert(1)", title: "x" },
			{ type: "url_citation", url: "file:///etc/passwd", title: "x" },
			{ type: "url_citation", url: "data:text/html,<script>1</script>", title: "x" },
			{ type: "url_citation", url: "obsidian://open?vault=x", title: "x" },
			{ type: "url_citation", url: "not a url", title: "x" },
			{ type: "url_citation", url: "http://ok.example/", title: "ok" },
		]));
		assert.deepEqual(citations, [{ url: "http://ok.example/", title: "ok" }]);
	});

	it("ignores other annotation types and mistyped fields", () => {
		const citations = extractOpenAIResponsesCitations(withAnnotations([
			{ type: "file_citation", url: "https://a.example/" },
			{ type: "url_citation", url: 42 },
			{ type: "url_citation" },
			null,
			"text",
			{ type: "url_citation", url: "https://b.example/", title: 7 },
		]));
		assert.deepEqual(citations, [{ url: "https://b.example/", title: "" }]);
	});

	it("returns an empty list for malformed input", () => {
		for (const bad of [{}, { output: "x" }, { output: [null] }, { output: [{ content: [{ type: "output_text", annotations: "x" }] }] }]) {
			assert.deepEqual(extractOpenAIResponsesCitations(bad as Record<string, unknown>), []);
		}
	});
});

describe("formatCitations", () => {
	it("lists only the sources the answer does not already link", () => {
		const out = formatCitations(
			"See [A](https://a.example/page).",
			[{ url: "https://a.example/page", title: "A" }, { url: "https://b.example/", title: "B" }],
			"Sources",
		);
		assert.equal(out, "\n\n**Sources**\n- [B](https://b.example/)");
	});

	it("returns an empty string when there is nothing to add", () => {
		assert.equal(formatCitations("text", [], "Sources"), "");
		assert.equal(formatCitations("https://a.example/", [{ url: "https://a.example/", title: "A" }], "Sources"), "");
	});

	it("falls back to the URL when the title is empty", () => {
		const out = formatCitations("", [{ url: "https://a.example/", title: "" }], "Sources");
		assert.ok(out.endsWith("- [https://a.example/](https://a.example/)"));
	});

	it("keeps a hostile title from breaking out of the link", () => {
		const out = formatCitations(
			"",
			[{ url: "https://a.example/", title: "x](https://evil.example/) [y\n# heading" }],
			"Sources",
		);
		const line = out.split("\n").pop() ?? "";
		assert.equal(line.includes("["), true);
		assert.equal((line.match(/\[/g) ?? []).length, 1);
		assert.equal((line.match(/\]/g) ?? []).length, 1);
		assert.ok(line.endsWith("](https://a.example/)"));
	});

	it("caps the title length", () => {
		const out = formatCitations("", [{ url: "https://a.example/", title: "t".repeat(500) }], "Sources");
		assert.ok(out.length < 200);
	});

	it("escapes characters that would end the link target", () => {
		const out = formatCitations("", [{ url: "https://a.example/wiki/X_(y)", title: "X" }], "Sources");
		assert.ok(out.endsWith("- [X](https://a.example/wiki/X_%28y%29)"));
	});
});

describe("Anthropic response readers", () => {
	it("reads the stop reason only when it is a string", () => {
		assert.equal(readAnthropicStopReason({ stop_reason: "refusal" }), "refusal");
		assert.equal(readAnthropicStopReason({ stop_reason: "pause_turn" }), "pause_turn");
		assert.equal(readAnthropicStopReason({ stop_reason: null }), null);
		assert.equal(readAnthropicStopReason({ stop_reason: 3 }), null);
		assert.equal(readAnthropicStopReason({}), null);
	});

	it("returns the content blocks, or an empty list when they are missing", () => {
		const blocks = [{ type: "text", text: "a" }];
		assert.deepEqual(readAnthropicContent({ content: blocks }), blocks);
		assert.deepEqual(readAnthropicContent({ content: "text" }), []);
		assert.deepEqual(readAnthropicContent({}), []);
	});

	it("reads the serving model only when it is a non-empty string", () => {
		assert.equal(readServedModel({ model: "claude-opus-4-8" }), "claude-opus-4-8");
		assert.equal(readServedModel({ model: "" }), null);
		assert.equal(readServedModel({ model: 1 }), null);
		assert.equal(readServedModel({}), null);
	});
});
