import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_CLAUDE_MODEL,
	DEFAULT_OPENAI_MODEL,
	MODEL_CATALOG,
	ModelAccessError,
	RETIRED_MODELS,
	detectProvider,
	findCatalogEntry,
	getCatalogModels,
	getFallbackModel,
	getReplacementModel,
	isOpenAIReasoningModel,
	normalizeThinkingMode,
	resolveAnthropicProfile,
	resolveOpenAIProfile,
	supportsWebSearch,
} from "../../src/models";
import { t, setLanguage } from "../../src/i18n";

const MODES = ["fast", "normal", "think"] as const;

describe("MODEL_CATALOG", () => {
	it("has unique, lowercase ids", () => {
		const ids = MODEL_CATALOG.map(entry => entry.id);
		assert.equal(new Set(ids).size, ids.length);
		for (const id of ids) assert.equal(id, id.toLowerCase());
	});

	it("assigns every entry to the provider its id implies", () => {
		for (const entry of MODEL_CATALOG) {
			assert.equal(detectProvider(entry.id), entry.provider, entry.id);
		}
	});

	it("has a translated description for every entry in both languages", () => {
		try {
			for (const lang of ["en", "pl"]) {
				setLanguage(lang);
				for (const entry of MODEL_CATALOG) {
					const text = t(entry.descKey);
					assert.notEqual(text, entry.descKey, `${entry.id} has no ${lang} description`);
					assert.ok(text.length > 0);
				}
			}
		} finally {
			setLanguage("en");
		}
	});

	it("maps every thinking mode to an effort for reasoning models", () => {
		for (const entry of MODEL_CATALOG) {
			if (!entry.effortByMode) continue;
			for (const mode of MODES) {
				assert.ok(
					["none", "low", "medium", "high"].includes(entry.effortByMode[mode]),
					`${entry.id}/${mode}`,
				);
			}
		}
	});

	it("never sends effort 'none' to a model that rejects it", () => {
		const astra = findCatalogEntry("gpt-6-astra");
		assert.ok(astra?.effortByMode);
		for (const mode of MODES) assert.notEqual(astra.effortByMode[mode], "none");

		for (const entry of getCatalogModels("anthropic")) {
			if (!entry.effortByMode) continue;
			for (const mode of MODES) assert.notEqual(entry.effortByMode[mode], "none", entry.id);
		}
	});

	it("lists the default models as current, not legacy", () => {
		for (const id of [DEFAULT_OPENAI_MODEL, DEFAULT_CLAUDE_MODEL]) {
			const entry = findCatalogEntry(id);
			assert.ok(entry, id);
			assert.equal(entry.legacy, false);
		}
	});

	it("does not offer the models the project decided against", () => {
		for (const id of ["claude-fable-5-1", "claude-fable-5", "gpt-4-turbo", "gpt-5", "gpt-5.4"]) {
			assert.equal(findCatalogEntry(id), null, id);
		}
	});

	it("uses the basic web search tool only for Haiku 4.5", () => {
		assert.equal(resolveAnthropicProfile("claude-haiku-4-5").webSearchTool, "web_search_20250305");
		assert.equal(resolveAnthropicProfile("claude-sonnet-5-5").webSearchTool, "web_search_20260209");
		assert.equal(resolveAnthropicProfile("claude-opus-5-5").webSearchTool, "web_search_20260209");
	});
});

describe("findCatalogEntry", () => {
	it("ignores case and surrounding whitespace", () => {
		assert.equal(findCatalogEntry("  GPT-6-Sol ")?.id, "gpt-6-sol");
	});

	it("returns null for unknown or empty input", () => {
		assert.equal(findCatalogEntry("llama3"), null);
		assert.equal(findCatalogEntry(""), null);
		assert.equal(findCatalogEntry(undefined as unknown as string), null);
	});
});

describe("RETIRED_MODELS", () => {
	it("replaces every retired model with a catalogue model of the same provider", () => {
		for (const [retired, replacement] of Object.entries(RETIRED_MODELS)) {
			const entry = findCatalogEntry(replacement);
			assert.ok(entry, `${retired} -> ${replacement} is not in the catalogue`);
			assert.equal(entry.provider, detectProvider(retired), retired);
		}
	});

	it("never retires a model that is still offered", () => {
		for (const retired of Object.keys(RETIRED_MODELS)) {
			assert.equal(findCatalogEntry(retired), null, retired);
		}
	});

	it("does not chain: a replacement is never itself retired", () => {
		for (const replacement of Object.values(RETIRED_MODELS)) {
			assert.equal(getReplacementModel(replacement), null, replacement);
		}
	});

	it("leaves current and custom models alone", () => {
		assert.equal(getReplacementModel("gpt-6-sol"), null);
		assert.equal(getReplacementModel("claude-haiku-4-5"), null);
		assert.equal(getReplacementModel("my-local-model"), null);
		assert.equal(getReplacementModel(""), null);
	});

	it("matches case-insensitively", () => {
		assert.equal(getReplacementModel("GPT-4-Turbo"), "gpt-6-sol");
	});
});

describe("detectProvider", () => {
	it("recognizes the new model families", () => {
		assert.equal(detectProvider("gpt-6-astra"), "openai");
		assert.equal(detectProvider("gpt-5.6-terra"), "openai");
		assert.equal(detectProvider("claude-opus-5-5"), "anthropic");
	});

	it("treats everything else as a local model", () => {
		assert.equal(detectProvider("llama3:8b"), "local");
		assert.equal(detectProvider("qwen2.5-coder"), "local");
	});
});

describe("resolveOpenAIProfile — custom ids", () => {
	it("treats GPT-5 and later, and the o-series, as reasoning models", () => {
		for (const id of ["gpt-5.4", "gpt-5.6-sol", "gpt-7-nova", "o3", "o4-mini"]) {
			assert.equal(isOpenAIReasoningModel(id), true, id);
		}
	});

	it("never guesses effort 'none' for an unknown reasoning model", () => {
		const profile = resolveOpenAIProfile("gpt-5.4");
		assert.ok(profile.effortByMode);
		for (const mode of MODES) assert.notEqual(profile.effortByMode[mode], "none");
	});

	it("treats older GPT models as classic models without web search", () => {
		for (const id of ["gpt-4.1", "gpt-3.5-turbo", "chatgpt-4o-latest"]) {
			const profile = resolveOpenAIProfile(id);
			assert.equal(profile.effortByMode, null, id);
			assert.equal(profile.webSearch, false, id);
		}
	});
});

describe("resolveAnthropicProfile — custom ids", () => {
	it("uses adaptive thinking from the 4.6 generation on", () => {
		for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"]) {
			assert.equal(resolveAnthropicProfile(id).thinking, "adaptive", id);
		}
	});

	it("uses a token budget for older models", () => {
		for (const id of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-3-haiku-20240307"]) {
			assert.equal(resolveAnthropicProfile(id).thinking, "budget", id);
		}
	});

	it("does not mistake a dated snapshot suffix for a minor version", () => {
		assert.equal(resolveAnthropicProfile("claude-sonnet-4-20250514").thinking, "budget");
		assert.equal(resolveAnthropicProfile("claude-opus-4-5-20251101").thinking, "budget");
	});

	it("enables the refusal fallback only where it is known to be accepted", () => {
		assert.equal(resolveAnthropicProfile("claude-sonnet-5-5").refusalFallback, true);
		assert.equal(resolveAnthropicProfile("claude-opus-5-5").refusalFallback, true);
		assert.equal(resolveAnthropicProfile("claude-opus-5").refusalFallback, true);
		assert.equal(resolveAnthropicProfile("claude-haiku-4-5").refusalFallback, false);
		assert.equal(resolveAnthropicProfile("claude-opus-4-8").refusalFallback, false);
		assert.equal(resolveAnthropicProfile("claude-sonnet-4-5").refusalFallback, false);
	});
});

describe("supportsWebSearch", () => {
	it("is never available for the Local API", () => {
		assert.equal(supportsWebSearch("local", "llama3"), false);
		assert.equal(supportsWebSearch("local", "gpt-6-sol"), false);
	});

	it("is available for every catalogue model", () => {
		for (const entry of MODEL_CATALOG) {
			assert.equal(supportsWebSearch(entry.provider, entry.id), true, entry.id);
		}
	});

	it("is off for an unknown classic OpenAI model", () => {
		assert.equal(supportsWebSearch("openai", "gpt-4.1"), false);
	});
});

describe("getFallbackModel", () => {
	it("offers the cheapest current model first", () => {
		assert.equal(getFallbackModel("gpt-6-astra"), "gpt-6-luna");
		assert.equal(getFallbackModel("some-custom-model"), "gpt-6-luna");
	});

	it("never offers the model that just failed", () => {
		assert.equal(getFallbackModel("gpt-6-luna"), "gpt-4o-mini");
		assert.equal(getFallbackModel("GPT-6-Luna"), "gpt-4o-mini");
	});

	it("always returns a catalogue model", () => {
		for (const failed of ["gpt-6-luna", "gpt-4o-mini", "gpt-4o", "x"]) {
			assert.ok(findCatalogEntry(getFallbackModel(failed)), failed);
		}
	});
});

describe("normalizeThinkingMode", () => {
	it("falls back to normal for anything unknown", () => {
		assert.equal(normalizeThinkingMode("fast"), "fast");
		assert.equal(normalizeThinkingMode("think"), "think");
		assert.equal(normalizeThinkingMode("normal"), "normal");
		assert.equal(normalizeThinkingMode(""), "normal");
		assert.equal(normalizeThinkingMode("turbo"), "normal");
	});
});

describe("ModelAccessError", () => {
	it("is never retried", () => {
		const error = new ModelAccessError("nope", { model: "gpt-6-astra", status: 403 });
		assert.equal(error.noRetry, true);
		assert.equal(error.name, "ModelAccessError");
		assert.equal(error.model, "gpt-6-astra");
	});
});
