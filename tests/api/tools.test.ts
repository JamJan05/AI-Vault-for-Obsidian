/**
 * Tool calls in requests and replies. The definitions decide what a model is
 * offered, and the replies are untrusted input, so both are pinned down here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildAnthropicRequest,
	buildAnthropicToolResults,
	buildOpenAIRequest,
	buildOpenAIToolResults,
} from "../../src/api/requests";
import { readAnthropicToolCalls, readOpenAIToolCalls } from "../../src/api/contracts";
import { MAX_TOOL_ROUNDS, joinReplyText, runToolCalls } from "../../src/api/toolLoop";
import { MODEL_CATALOG } from "../../src/models";
import { NOTE_TOOL_DEFINITIONS } from "../../src/tools/noteTools";
import type { ChatMessage } from "../../src/types";
import type { ToolCall, ToolSet } from "../../src/tools/types";

const MESSAGES: ChatMessage[] = [
	{ role: "system", content: "SYSTEM" },
	{ role: "user",   content: "question" },
];

const toolsOf = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
	(body.tools ?? []) as Array<Record<string, unknown>>;

describe("requests without tools", () => {
	it("offer no function to any model", () => {
		for (const entry of MODEL_CATALOG) {
			for (const tools of [undefined, []]) {
				const body = entry.provider === "openai"
					? buildOpenAIRequest({ model: entry.id, messages: MESSAGES, mode: "normal", tools }).body
					: buildAnthropicRequest({ model: entry.id, messages: MESSAGES, mode: "normal", tools }).body;
				assert.equal(body.tools, undefined, entry.id);
				assert.equal(body.include, undefined, entry.id);
			}
		}
	});

	it("leave web search as the only tool when it is on", () => {
		const openai = buildOpenAIRequest({ model: "gpt-6-sol", messages: MESSAGES, mode: "normal", webSearch: true });
		assert.deepEqual(openai.body.tools, [{ type: "web_search" }]);
		const claude = buildAnthropicRequest({ model: "claude-sonnet-5-5", messages: MESSAGES, mode: "normal", webSearch: true });
		assert.deepEqual(toolsOf(claude.body).map(tool => tool.name), ["web_search"]);
	});
});

describe("buildOpenAIRequest — tools", () => {
	it("uses the Responses API for every model, declines storage, and sends strict functions", () => {
		for (const entry of MODEL_CATALOG) {
			if (entry.provider !== "openai") continue;
			const request = buildOpenAIRequest({
				model: entry.id, messages: MESSAGES, mode: "normal", tools: NOTE_TOOL_DEFINITIONS,
			});
			assert.equal(request.endpoint, "responses", entry.id);
			assert.equal(request.body.store, false, entry.id);

			const tools = toolsOf(request.body);
			assert.deepEqual(tools.map(tool => tool.name), NOTE_TOOL_DEFINITIONS.map(tool => tool.name));
			for (const tool of tools) {
				assert.equal(tool.type, "function");
				assert.equal(tool.strict, true);
			}
		}
	});

	it("asks for encrypted reasoning only from reasoning models", () => {
		const reasoning = buildOpenAIRequest({ model: "gpt-6-sol", messages: MESSAGES, mode: "normal", tools: NOTE_TOOL_DEFINITIONS });
		assert.deepEqual(reasoning.body.include, ["reasoning.encrypted_content"]);
		const classic = buildOpenAIRequest({ model: "gpt-4o", messages: MESSAGES, mode: "normal", tools: NOTE_TOOL_DEFINITIONS });
		assert.equal(classic.body.include, undefined);
		assert.equal(classic.body.reasoning, undefined);
	});

	it("keeps web search next to the functions", () => {
		const request = buildOpenAIRequest({
			model: "gpt-6-sol", messages: MESSAGES, mode: "normal", webSearch: true, tools: NOTE_TOOL_DEFINITIONS,
		});
		assert.deepEqual(toolsOf(request.body)[0], { type: "web_search" });
		assert.equal(toolsOf(request.body).length, NOTE_TOOL_DEFINITIONS.length + 1);
	});
});

describe("buildAnthropicRequest — tools", () => {
	it("sends each definition with its input schema", () => {
		const request = buildAnthropicRequest({
			model: "claude-sonnet-5-5", messages: MESSAGES, mode: "normal", tools: NOTE_TOOL_DEFINITIONS,
		});
		const tools = toolsOf(request.body);
		assert.deepEqual(tools.map(tool => tool.name), NOTE_TOOL_DEFINITIONS.map(tool => tool.name));
		assert.deepEqual(tools[0].input_schema, NOTE_TOOL_DEFINITIONS[0].parameters);
		assert.equal(tools[0].type, undefined);
	});
});

describe("tool result bodies", () => {
	it("append the assistant content unchanged and one result per call (Anthropic)", () => {
		const body = { model: "m", messages: [{ role: "user", content: "q" }], max_tokens: 10 };
		const assistant = [
			{ type: "thinking", thinking: "…", signature: "sig" },
			{ type: "tool_use", id: "toolu_1", name: "read_note", input: { path: "A.md" } },
		];
		const next = buildAnthropicToolResults(body, assistant, [
			{ id: "toolu_1", content: "text", isError: false },
			{ id: "toolu_2", content: "bad", isError: true },
		]);

		assert.deepEqual(next.messages, [
			{ role: "user", content: "q" },
			{ role: "assistant", content: assistant },
			{ role: "user", content: [
				{ type: "tool_result", tool_use_id: "toolu_1", content: "text" },
				{ type: "tool_result", tool_use_id: "toolu_2", content: "bad", is_error: true },
			] },
		]);
		assert.equal(next.max_tokens, 10);
		assert.equal(body.messages.length, 1, "the original body is not modified");
	});

	it("append the output items and one result per call (OpenAI)", () => {
		const body = { model: "m", input: [{ type: "message", role: "user" }], store: false };
		const output = [
			{ type: "reasoning", id: "rs_1", encrypted_content: "abc" },
			{ type: "function_call", call_id: "call_1", name: "read_note", arguments: "{}" },
		];
		const next = buildOpenAIToolResults(body, output, [{ id: "call_1", content: "text", isError: false }]);

		assert.deepEqual(next.input, [
			{ type: "message", role: "user" },
			...output,
			{ type: "function_call_output", call_id: "call_1", output: "text" },
		]);
		assert.equal(next.store, false);
		assert.equal(body.input.length, 1, "the original body is not modified");
	});
});

describe("reading tool calls from a reply", () => {
	it("takes tool_use blocks and skips server tools and malformed blocks (Anthropic)", () => {
		const calls = readAnthropicToolCalls({ content: [
			{ type: "text", text: "Let me look." },
			{ type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
			{ type: "tool_use", id: "toolu_1", name: "read_note", input: { path: "A.md" } },
			{ type: "tool_use", name: "read_note", input: {} },
			{ type: "tool_use", id: 7, name: "read_note", input: {} },
			{ type: "tool_use", id: "toolu_2", input: {} },
			null, "tool_use",
		] });
		assert.deepEqual(calls, [{ id: "toolu_1", name: "read_note", input: { path: "A.md" } }]);
		assert.deepEqual(readAnthropicToolCalls({}), []);
		assert.deepEqual(readAnthropicToolCalls({ content: "tool_use" }), []);
	});

	it("parses function_call arguments and survives broken JSON (OpenAI)", () => {
		const calls = readOpenAIToolCalls({ output: [
			{ type: "reasoning", id: "rs_1" },
			{ type: "web_search_call", id: "ws_1" },
			{ type: "function_call", call_id: "call_1", name: "read_note", arguments: "{\"path\":\"A.md\"}" },
			{ type: "function_call", call_id: "call_2", name: "edit_note", arguments: "{broken" },
			{ type: "function_call", call_id: "call_3", name: "edit_note" },
			{ type: "function_call", name: "edit_note", arguments: "{}" },
			null,
		] });
		assert.deepEqual(calls, [
			{ id: "call_1", name: "read_note", input: { path: "A.md" } },
			{ id: "call_2", name: "edit_note", input: undefined },
			{ id: "call_3", name: "edit_note", input: undefined },
		]);
		assert.deepEqual(readOpenAIToolCalls({}), []);
	});
});

describe("runToolCalls", () => {
	const calls: ToolCall[] = [
		{ id: "a", name: "read_note", input: {} },
		{ id: "b", name: "edit_note", input: {} },
	];

	function recorder(): { tools: ToolSet; ran: string[] } {
		const ran: string[] = [];
		return {
			ran,
			tools: {
				definitions: [],
				run: async call => { ran.push(call.id); return { content: `ran ${call.id}`, isError: false }; },
			},
		};
	}

	it("runs the calls in order and pairs each result with its call", async () => {
		const { tools, ran } = recorder();
		const results = await runToolCalls(tools, calls, null, false);
		assert.deepEqual(ran, ["a", "b"]);
		assert.deepEqual(results, [
			{ id: "a", content: "ran a", isError: false },
			{ id: "b", content: "ran b", isError: false },
		]);
	});

	it("runs nothing once the limit is reached, and still answers every call", async () => {
		const { tools, ran } = recorder();
		const results = await runToolCalls(tools, calls, null, true);
		assert.deepEqual(ran, []);
		assert.deepEqual(results.map(result => [result.id, result.isError]), [["a", true], ["b", true]]);
		assert.ok(MAX_TOOL_ROUNDS > 0);
	});

	it("stops between calls when the exchange is aborted", async () => {
		const controller = new AbortController();
		const ran: string[] = [];
		const tools: ToolSet = {
			definitions: [],
			run: async call => { ran.push(call.id); controller.abort(); return { content: "", isError: false }; },
		};
		await assert.rejects(runToolCalls(tools, calls, controller.signal, false), { name: "AbortError" });
		assert.deepEqual(ran, ["a"]);
	});

	it("runs nothing when already aborted", async () => {
		const { tools, ran } = recorder();
		await assert.rejects(runToolCalls(tools, calls, AbortSignal.abort(), false), { name: "AbortError" });
		assert.deepEqual(ran, []);
	});
});

describe("joinReplyText", () => {
	it("separates passages and ignores empty ones", () => {
		assert.equal(joinReplyText("", "first"), "first");
		assert.equal(joinReplyText("first", " second "), "first\n\nsecond");
		assert.equal(joinReplyText("first", null), "first");
		assert.equal(joinReplyText("first", "  "), "first");
	});
});
