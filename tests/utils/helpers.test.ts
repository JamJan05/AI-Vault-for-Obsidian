import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";

import { createKeyedDebounce, newId } from "../../src/utils";
import { isDefaultChatTitle, setLanguage } from "../../src/i18n";

// utils.ts uses window timers so that Obsidian pop-out windows work.
before(() => {
	(globalThis as { window?: unknown }).window ??= globalThis;
});

describe("createKeyedDebounce", () => {
	it("does not let one key cancel another", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const calls: string[] = [];
			const debounced = createKeyedDebounce<string>((key, value) => calls.push(`${key}=${value}`), 3000);

			debounced("a.md", "A");
			mock.timers.tick(1000);
			debounced("b.md", "B");
			assert.equal(debounced.pending, 2);

			mock.timers.tick(2000);
			assert.deepEqual(calls, ["a.md=A"]);
			mock.timers.tick(1000);
			assert.deepEqual(calls, ["a.md=A", "b.md=B"]);
			assert.equal(debounced.pending, 0);
		} finally {
			mock.timers.reset();
		}
	});

	it("collapses repeated calls for the same key and keeps the last value", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const calls: string[] = [];
			const debounced = createKeyedDebounce<string>((_key, value) => calls.push(value), 100);

			debounced("a.md", "first");
			mock.timers.tick(50);
			debounced("a.md", "second");
			mock.timers.tick(99);
			assert.deepEqual(calls, []);
			mock.timers.tick(1);
			assert.deepEqual(calls, ["second"]);
		} finally {
			mock.timers.reset();
		}
	});

	it("cancel drops every pending call", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const calls: string[] = [];
			const debounced = createKeyedDebounce<string>((key) => calls.push(key), 100);

			debounced("a.md", "");
			debounced("b.md", "");
			debounced.cancel();
			mock.timers.tick(1000);

			assert.deepEqual(calls, []);
			assert.equal(debounced.pending, 0);
		} finally {
			mock.timers.reset();
		}
	});
});

describe("newId", () => {
	it("is unique even when many are made at once", () => {
		const ids = new Set(Array.from({ length: 5000 }, () => newId()));
		assert.equal(ids.size, 5000);
	});

	it("is safe to use inside a file name", () => {
		for (let i = 0; i < 50; i++) assert.match(newId(), /^[a-zA-Z0-9-]+$/);
	});

	it("still works, and stays file-name safe, without crypto.randomUUID", () => {
		const original = globalThis.crypto.randomUUID;
		Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
		try {
			const ids = new Set(Array.from({ length: 500 }, () => newId()));
			assert.equal(ids.size, 500);
			for (const id of ids) assert.match(id, /^[a-z0-9]+-[a-z0-9]{8}$/);
		} finally {
			Object.defineProperty(globalThis.crypto, "randomUUID", { value: original, configurable: true });
		}
	});
});

describe("isDefaultChatTitle", () => {
	it("recognizes the default title of every language, whatever language is active", () => {
		try {
			for (const lang of ["en", "pl"]) {
				setLanguage(lang);
				assert.equal(isDefaultChatTitle("New conversation"), true, lang);
				assert.equal(isDefaultChatTitle("Nowa rozmowa"), true, lang);
			}
		} finally {
			setLanguage("en");
		}
	});

	it("rejects a title the user or the auto-title has set", () => {
		assert.equal(isDefaultChatTitle("How do I cook rice?"), false);
		assert.equal(isDefaultChatTitle(""), false);
		assert.equal(isDefaultChatTitle("new conversation"), false);
	});
});
