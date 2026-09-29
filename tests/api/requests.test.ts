import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	ANTHROPIC_FALLBACK_BETA,
	ANTHROPIC_URL,
	OPENAI_CHAT_URL,
	OPENAI_RESPONSES_URL,
	buildAnthropicContinuation,
	buildAnthropicRequest,
	buildOpenAIRequest,
	padTokensForEffort,
} from "../../src/api/requests";
import { MODEL_CATALOG } from "../../src/models";
import type { ChatMessage } from "../../src/types";

const MESSAGES: ChatMessage[] = [
	{ role: "system",    content: "SYSTEM PROMPT" },
	{ role: "user",      content: "first question" },
	{ role: "assistant", content: "first answer" },
	{ role: "user",      content: "second question" },
];

const ALLOWED_HOSTS = new Set(["api.openai.com", "api.anthropic.com"]);

describe("request URLs", () => {
	it("only ever point at the two disclosed hosts, over https", () => {
		for (const raw of [OPENAI_RESPONSES_URL, OPENAI_CHAT_URL, ANTHROPIC_URL]) {
			const url = new URL(raw);
			assert.equal(url.protocol, "https:");
			assert.ok(ALLOWED_HOSTS.has(url.hostname), raw);
		}
	});
});

describe("padTokensForEffort", () => {
	it("adds headroom that grows with the effort", () => {
		assert.equal(padTokensForEffort(1000, null), 1000);
		assert.equal(padTokensForEffort(1000, "none"), 1000);
		assert.equal(padTokensForEffort(1000, "low"), 3000);
		assert.equal(padTokensForEffort(1000, "medium"), 5000);
		assert.equal(padTokensForEffort(1000, "high"), 13000);
	});
});

describe("buildOpenAIRequest — reasoning models", () => {
	it("uses the Responses API and declines server-side storage", () => {
		const request = buildOpenAIRequest({ model: "gpt-6-sol", messages: MESSAGES, mode: "normal" });
		assert.equal(request.endpoint, "responses");
		assert.equal(request.url, OPENAI_RESPONSES_URL);
		assert.equal(request.body.store, false);
	});

	it("declines storage for every model and mode that reaches the Responses API", () => {
		for (const entry of MODEL_CATALOG) {
			if (entry.provider !== "openai") continue;
			for (const mode of ["fast", "normal", "think"]) {
				for (const webSearch of [false, true]) {
					const request = buildOpenAIRequest({ model: entry.id, messages: MESSAGES, mode, webSearch });
					if (request.endpoint === "responses") {
						assert.equal(request.body.store, false, `${entry.id}/${mode}/${webSearch}`);
					}
				}
			}
		}
	});

	it("moves the system prompt to instructions and keeps the turns in order", () => {
		const { body } = buildOpenAIRequest({ model: "gpt-6-sol", messages: MESSAGES, mode: "normal" });
		assert.equal(body.instructions, "SYSTEM PROMPT");
		assert.deepEqual(body.input, [
			{ type: "message", role: "user",      content: [{ type: "input_text",  text: "first question" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] },
			{ type: "message", role: "user",      content: [{ type: "input_text",  text: "second question" }] },
		]);
	});

	it("omits instructions when there is no system prompt", () => {
		const { body } = buildOpenAIRequest({
			model: "gpt-6-sol", mode: "normal",
			messages: [{ role: "user", content: "hi" }],
		});
		assert.equal("instructions" in body, false);
	});

	it("maps thinking modes to the catalogue effort", () => {
		const effort = (model: string, mode: string): unknown =>
			(buildOpenAIRequest({ model, messages: MESSAGES, mode }).body.reasoning as { effort?: string } | undefined)?.effort;

		assert.equal(effort("gpt-6-sol", "fast"), "none");
		assert.equal(effort("gpt-6-sol", "normal"), "medium");
		assert.equal(effort("gpt-6-sol", "think"), "high");
		assert.equal(effort("gpt-6-astra", "fast"), "low");
		assert.equal(effort("gpt-6-luna", "normal"), "low");
		assert.equal(effort("gpt-5.6-terra", "think"), "high");
	});

	it("falls back to normal for an unknown mode", () => {
		const { body } = buildOpenAIRequest({ model: "gpt-6-sol", messages: MESSAGES, mode: "bogus" });
		assert.deepEqual(body.reasoning, { effort: "medium" });
	});

	it("raises effort 'none' to 'low' when web search is on", () => {
		const { body } = buildOpenAIRequest({ model: "gpt-6-sol", messages: MESSAGES, mode: "fast", webSearch: true });
		assert.deepEqual(body.reasoning, { effort: "low" });
		assert.deepEqual(body.tools, [{ type: "web_search" }]);
	});

	it("sends no tools unless web search was requested", () => {
		const { body } = buildOpenAIRequest({ model: "gpt-6-sol", messages: MESSAGES, mode: "normal" });
		assert.equal("tools" in body, false);
	});

	it("pads the output limit for reasoning", () => {
		const { body } = buildOpenAIRequest({ model: "gpt-6-sol", messages: MESSAGES, mode: "think", maxTokens: 1000 });
		assert.equal(body.max_output_tokens, 13000);
	});

	it("never sends sampling parameters or the retired 'minimal' effort", () => {
		for (const entry of MODEL_CATALOG) {
			if (entry.provider !== "openai") continue;
			for (const mode of ["fast", "normal", "think"]) {
				const { body } = buildOpenAIRequest({ model: entry.id, messages: MESSAGES, mode });
				assert.equal("temperature" in body, false);
				assert.equal("top_p" in body, false);
				assert.notEqual((body.reasoning as { effort?: string } | undefined)?.effort, "minimal");
			}
		}
	});
});

describe("buildOpenAIRequest — classic models", () => {
	it("uses Chat Completions with the system prompt as the first message", () => {
		const request = buildOpenAIRequest({ model: "gpt-4o", messages: MESSAGES, mode: "normal", maxTokens: 500 });
		assert.equal(request.endpoint, "chat-completions");
		assert.equal(request.url, OPENAI_CHAT_URL);
		assert.equal(request.body.max_tokens, 500);
		assert.equal("reasoning" in request.body, false);
		assert.deepEqual((request.body.messages as ChatMessage[])[0], { role: "system", content: "SYSTEM PROMPT" });
		assert.equal((request.body.messages as ChatMessage[]).length, 4);
	});

	it("switches to the Responses API for web search, without reasoning", () => {
		const request = buildOpenAIRequest({ model: "gpt-4o", messages: MESSAGES, mode: "think", webSearch: true, maxTokens: 500 });
		assert.equal(request.endpoint, "responses");
		assert.equal(request.body.store, false);
		assert.equal("reasoning" in request.body, false);
		assert.equal(request.body.max_output_tokens, 500);
		assert.deepEqual(request.body.tools, [{ type: "web_search" }]);
	});

	it("ignores a web search request for a model that cannot search", () => {
		const request = buildOpenAIRequest({ model: "gpt-4.1", messages: MESSAGES, mode: "normal", webSearch: true });
		assert.equal(request.endpoint, "chat-completions");
		assert.equal("tools" in request.body, false);
	});
});

describe("buildAnthropicRequest — adaptive thinking", () => {
	it("sends adaptive thinking with an effort and never a token budget", () => {
		for (const model of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
			for (const [mode, effort] of [["fast", "low"], ["normal", "medium"], ["think", "high"]]) {
				const { body } = buildAnthropicRequest({ model, messages: MESSAGES, mode });
				assert.deepEqual(body.thinking, { type: "adaptive" }, `${model}/${mode}`);
				assert.deepEqual(body.output_config, { effort }, `${model}/${mode}`);
			}
		}
	});

	it("lifts the system prompt out of the messages", () => {
		const { body } = buildAnthropicRequest({ model: "claude-sonnet-5-5", messages: MESSAGES, mode: "normal" });
		assert.equal(body.system, "SYSTEM PROMPT");
		const roles = (body.messages as ChatMessage[]).map(m => m.role);
		assert.deepEqual(roles, ["user", "assistant", "user"]);
	});

	it("pads max_tokens for thinking", () => {
		const { body } = buildAnthropicRequest({ model: "claude-sonnet-5-5", messages: MESSAGES, mode: "think", maxTokens: 1000 });
		assert.equal(body.max_tokens, 13000);
	});

	it("opts into the refusal fallback with the matching beta header", () => {
		const request = buildAnthropicRequest({ model: "claude-opus-5-5", messages: MESSAGES, mode: "normal" });
		assert.equal(request.body.fallbacks, "default");
		assert.deepEqual(request.betas, [ANTHROPIC_FALLBACK_BETA]);
	});

	it("uses the current web search tool", () => {
		const { body } = buildAnthropicRequest({ model: "claude-sonnet-5-5", messages: MESSAGES, mode: "normal", webSearch: true });
		assert.deepEqual(body.tools, [{ type: "web_search_20260209", name: "web_search" }]);
	});

	it("never sends sampling parameters or forced tool use", () => {
		for (const entry of MODEL_CATALOG) {
			if (entry.provider !== "anthropic") continue;
			const { body } = buildAnthropicRequest({ model: entry.id, messages: MESSAGES, mode: "think", webSearch: true });
			for (const key of ["temperature", "top_p", "top_k", "tool_choice"]) {
				assert.equal(key in body, false, `${entry.id}/${key}`);
			}
		}
	});
});

describe("buildAnthropicRequest — token budget models", () => {
	it("thinks only in think mode", () => {
		const fast  = buildAnthropicRequest({ model: "claude-haiku-4-5", messages: MESSAGES, mode: "fast", maxTokens: 1000 });
		const think = buildAnthropicRequest({ model: "claude-haiku-4-5", messages: MESSAGES, mode: "think", maxTokens: 2000 });

		assert.equal("thinking" in fast.body, false);
		assert.equal(fast.body.max_tokens, 1000);

		assert.deepEqual(think.body.thinking, { type: "enabled", budget_tokens: 2000 });
		assert.equal(think.body.max_tokens, 10000);
	});

	it("keeps the budget below max_tokens", () => {
		const { body } = buildAnthropicRequest({ model: "claude-haiku-4-5", messages: MESSAGES, mode: "think" });
		const budget = (body.thinking as { budget_tokens: number }).budget_tokens;
		assert.ok(budget >= 1024);
		assert.ok(budget < (body.max_tokens as number));
	});

	it("never sends a budget below the minimum the API accepts", () => {
		for (const maxTokens of [256, 512, 1023]) {
			const { body } = buildAnthropicRequest({ model: "claude-haiku-4-5", messages: MESSAGES, mode: "think", maxTokens });
			const budget = (body.thinking as { budget_tokens: number }).budget_tokens;
			assert.equal(budget, 1024, String(maxTokens));
			assert.ok(budget < (body.max_tokens as number));
		}
	});

	it("leaves the limit alone outside think mode", () => {
		const { body } = buildAnthropicRequest({ model: "claude-haiku-4-5", messages: MESSAGES, mode: "fast", maxTokens: 256 });
		assert.equal(body.max_tokens, 256);
	});

	it("sends neither an effort nor the fallback parameter", () => {
		const request = buildAnthropicRequest({ model: "claude-haiku-4-5", messages: MESSAGES, mode: "think" });
		assert.equal("output_config" in request.body, false);
		assert.equal("fallbacks" in request.body, false);
		assert.deepEqual(request.betas, []);
	});

	it("uses the basic web search tool", () => {
		const { body } = buildAnthropicRequest({ model: "claude-haiku-4-5", messages: MESSAGES, mode: "normal", webSearch: true });
		assert.deepEqual(body.tools, [{ type: "web_search_20250305", name: "web_search" }]);
	});
});

describe("buildAnthropicContinuation", () => {
	it("appends the paused assistant content and changes nothing else", () => {
		const { body } = buildAnthropicRequest({ model: "claude-sonnet-5-5", messages: MESSAGES, mode: "normal", webSearch: true });
		const paused = [{ type: "server_tool_use", id: "x", name: "web_search" }];
		const next = buildAnthropicContinuation(body, paused);

		const before = body.messages as unknown[];
		const after  = next.messages as unknown[];
		assert.equal(after.length, before.length + 1);
		assert.deepEqual(after.slice(0, before.length), before);
		assert.deepEqual(after[after.length - 1], { role: "assistant", content: paused });

		const { messages: _a, ...restBefore } = body;
		const { messages: _b, ...restAfter }  = next;
		assert.deepEqual(restAfter, restBefore);
	});

	it("does not mutate the original body", () => {
		const { body } = buildAnthropicRequest({ model: "claude-sonnet-5-5", messages: MESSAGES, mode: "normal" });
		const length = (body.messages as unknown[]).length;
		buildAnthropicContinuation(body, [{ type: "text", text: "partial" }]);
		assert.equal((body.messages as unknown[]).length, length);
	});
});
