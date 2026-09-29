/**
 * The system prompt is what carries note text to a provider. Its limits are part
 * of what PRIVACY.md promises, so they are tested against the documented numbers.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	ATTACHED_NOTE_CHARS,
	MAX_SYSTEM_CHARS,
	composeSystemPrompt,
} from "../../src/chat/systemPrompt";
import { setLanguage } from "../../src/i18n";
import type { SystemPromptParts } from "../../src/chat/systemPrompt";

const BASE: SystemPromptParts = {
	basePrompt: "BASE PROMPT",
	chatMode:   "chat",
	attached:   [],
	retrieved:  [],
	project:    null,
};

const compose = (overrides: Partial<SystemPromptParts>): string =>
	composeSystemPrompt({ ...BASE, ...overrides });

afterEach(() => setLanguage("en"));

describe("composeSystemPrompt", () => {
	it("is just the base prompt when nothing else is active", () => {
		assert.equal(compose({}), "BASE PROMPT");
	});

	it("keeps the limits PRIVACY.md documents", () => {
		assert.equal(MAX_SYSTEM_CHARS, 120_000);
		assert.equal(ATTACHED_NOTE_CHARS, 3000);
	});

	it("includes nothing from the vault unless it was passed in", () => {
		const prompt = compose({});
		for (const marker of ["VAULT CONTEXT", "###", "---"]) {
			assert.equal(prompt.includes(marker), false, marker);
		}
	});

	it("replaces the base prompt in code mode", () => {
		const prompt = compose({ chatMode: "code" });
		assert.equal(prompt.includes("BASE PROMPT"), false);
		assert.match(prompt, /RULES:/);
	});

	it("appends the quiz instruction in learn mode", () => {
		const prompt = compose({ chatMode: "learn" });
		assert.ok(prompt.startsWith("BASE PROMPT"));
		assert.match(prompt, /LEARN MODE/);
	});

	it("writes the mode prompts in the interface language", () => {
		setLanguage("pl");
		assert.match(compose({ chatMode: "code" }), /ZASADY:/);
		assert.match(compose({ chatMode: "learn" }), /TRYBIE NAUKI/);
	});

	it("adds attached notes under their titles", () => {
		const prompt = compose({ attached: [{ title: "Trip", text: "We went to Gdańsk." }] });
		assert.match(prompt, /NOTES SELECTED BY USER/);
		assert.match(prompt, /### Trip\nWe went to Gdańsk\./);
	});

	it("cuts each attached note at the documented length", () => {
		const prompt = compose({ attached: [{ title: "Long", text: "§".repeat(10_000) + "TAIL" }] });
		assert.equal(prompt.includes("TAIL"), false);
		assert.equal((prompt.match(/§/g) ?? []).length, ATTACHED_NOTE_CHARS);
	});

	it("adds retrieved fragments whole", () => {
		const fragment = "b".repeat(1200);
		const prompt = compose({ retrieved: [{ title: "Note", text: fragment }] });
		assert.match(prompt, /VAULT CONTEXT \(RAG\):/);
		assert.ok(prompt.includes(`### Note\n${fragment}`));
	});

	it("adds the project context with the project name", () => {
		const prompt = compose({ project: { name: "Thesis", context: "Earlier chats…" } });
		assert.match(prompt, /CONTEXT FROM PROJECT "Thesis"/);
		assert.ok(prompt.includes("Earlier chats…"));
	});

	it("skips a project without context", () => {
		assert.equal(compose({ project: { name: "Thesis", context: "" } }), "BASE PROMPT");
	});

	it("keeps the sections in a fixed order", () => {
		const prompt = compose({
			attached:  [{ title: "A", text: "ATTACHED" }],
			retrieved: [{ title: "R", text: "RETRIEVED" }],
			project:   { name: "P", context: "PROJECT" },
		});
		const order = ["BASE PROMPT", "ATTACHED", "RETRIEVED", "PROJECT"].map(marker => prompt.indexOf(marker));
		assert.deepEqual([...order].sort((a, b) => a - b), order);
		assert.ok(order.every(position => position >= 0));
	});

	it("cuts the whole prompt at the documented length and says so", () => {
		const prompt = compose({
			retrieved: Array.from({ length: 200 }, (_v, i) => ({ title: `N${i}`, text: "c".repeat(1200) })),
		});
		assert.ok(prompt.length > MAX_SYSTEM_CHARS);
		assert.ok(prompt.length < MAX_SYSTEM_CHARS + 200);
		assert.match(prompt, /context truncated/);
		assert.ok(prompt.startsWith("BASE PROMPT"));
	});

	it("does not mention truncation when nothing was cut", () => {
		assert.equal(compose({ retrieved: [{ title: "N", text: "short" }] }).includes("truncated"), false);
	});
});
