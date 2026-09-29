import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	applyModelChoice,
	buildModelGroups,
	formatModelLabel,
	getActiveModel,
	getProviderLabel,
} from "../../src/chat/modelOptions";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { MODEL_CATALOG } from "../../src/models";

const settings = (overrides: Partial<typeof DEFAULT_SETTINGS> = {}): typeof DEFAULT_SETTINGS =>
	({ ...DEFAULT_SETTINGS, localModelsCache: [], ...overrides });

describe("getActiveModel", () => {
	it("returns the model of the active provider", () => {
		assert.equal(getActiveModel(settings({ provider: "openai", model: "gpt-6-luna" })), "gpt-6-luna");
		assert.equal(getActiveModel(settings({ provider: "anthropic", claudeModel: "claude-opus-5-5" })), "claude-opus-5-5");
		assert.equal(getActiveModel(settings({ provider: "local", localModel: "  llama3  " })), "llama3");
	});

	it("is empty for a local provider without a model", () => {
		assert.equal(getActiveModel(settings({ provider: "local", localModel: "" })), "");
	});
});

describe("buildModelGroups", () => {
	it("lists every provider, in a fixed order", () => {
		const groups = buildModelGroups(settings());
		assert.deepEqual(groups.map(g => g.provider), ["openai", "anthropic", "local"]);
	});

	it("lists every catalogue model exactly once", () => {
		const ids = buildModelGroups(settings()).flatMap(g => g.models.map(m => m.id));
		for (const entry of MODEL_CATALOG) {
			assert.equal(ids.filter(id => id === entry.id).length, 1, entry.id);
		}
	});

	it("puts older models after the current ones", () => {
		const openai = buildModelGroups(settings()).find(g => g.provider === "openai");
		assert.ok(openai);
		const firstLegacy = openai.models.findIndex(m => m.legacy);
		assert.ok(firstLegacy > 0);
		assert.ok(openai.models.slice(firstLegacy).every(m => m.legacy));
	});

	it("gives every model a description", () => {
		for (const group of buildModelGroups(settings({ localModelsCache: ["llama3"] }))) {
			for (const model of group.models) assert.ok(model.desc.length > 0, model.id);
		}
	});

	it("adds a hand-typed model to its own provider only", () => {
		const groups = buildModelGroups(settings({ provider: "openai", model: "gpt-7-custom" }));
		assert.equal(groups[0].models[0].id, "gpt-7-custom");
		assert.equal(groups[1].models.some(m => m.id === "gpt-7-custom"), false);
		assert.equal(groups[2].models.some(m => m.id === "gpt-7-custom"), false);
	});

	it("lists the cached local models and the current one", () => {
		const groups = buildModelGroups(settings({
			provider: "anthropic", localModel: "mistral", localModelsCache: ["llama3", "qwen"],
		}));
		assert.deepEqual(groups[2].models.map(m => m.id), ["mistral", "llama3", "qwen"]);
	});

	it("has an empty local group when there are no local models", () => {
		assert.deepEqual(buildModelGroups(settings())[2].models, []);
	});

	it("does not modify the settings", () => {
		const input = settings({ localModelsCache: ["llama3"] });
		const before = JSON.stringify(input);
		buildModelGroups(input);
		assert.equal(JSON.stringify(input), before);
	});
});

describe("applyModelChoice", () => {
	it("sets the provider and only that provider's model", () => {
		const input = settings({ model: "gpt-6-sol", claudeModel: "claude-sonnet-5-5", localModel: "llama3" });

		applyModelChoice(input, "anthropic", "claude-opus-5-5");
		assert.equal(input.provider, "anthropic");
		assert.equal(input.claudeModel, "claude-opus-5-5");
		assert.equal(input.model, "gpt-6-sol");
		assert.equal(input.localModel, "llama3");

		applyModelChoice(input, "local", "qwen");
		assert.equal(input.provider, "local");
		assert.equal(input.localModel, "qwen");
		assert.equal(input.claudeModel, "claude-opus-5-5");
	});
});

describe("labels", () => {
	it("uses the catalogue label, or the id for an unknown model", () => {
		assert.equal(formatModelLabel("gpt-6-sol"), "GPT-6 Sol");
		assert.equal(formatModelLabel("llama3:8b"), "llama3:8b");
	});

	it("names each provider", () => {
		assert.equal(getProviderLabel("openai"), "GPT");
		assert.equal(getProviderLabel("anthropic"), "Claude");
		assert.equal(getProviderLabel("local"), "Local API");
	});
});
