/**
 * Sources are written to the conversation history and read back from disk.
 * They must keep as little note text as possible, survive a damaged file, and
 * never travel to a provider.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SOURCE_ANCHOR_CHARS, sanitizeSources, toMessageSource } from "../../src/rag/sources";
import { locateChunk } from "../../src/rag/locate";
import { buildAnthropicRequest, buildOpenAIRequest } from "../../src/api/requests";
import type { ChatMessage } from "../../src/types";

describe("toMessageSource", () => {
	it("keeps only the beginning of the fragment", () => {
		const chunk = "x".repeat(1200);
		const source = toMessageSource("Note", "folder/Note.md", chunk);
		assert.equal(source.anchor?.length, SOURCE_ANCHOR_CHARS);
		assert.equal(source.length, 1200);
		assert.equal(JSON.stringify(source).length < 300, true);
	});

	it("stores no anchor for a note that was attached rather than searched", () => {
		assert.deepEqual(toMessageSource("Note", "Note.md"), { label: "Note", path: "Note.md" });
		assert.deepEqual(toMessageSource("Note", "Note.md", "   "), { label: "Note", path: "Note.md" });
	});

	it("produces an anchor that finds the fragment again", () => {
		const fragment = "The pierogi near the crane were the best we had all week. ".repeat(8).trim();
		const note = `# Trip\n\nIntro paragraph.\n\n${fragment}\n\nThe end.`;
		const source = toMessageSource("Trip", "Trip.md", fragment);

		const range = locateChunk(note, source.anchor ?? "");
		assert.ok(range);
		assert.equal(range.start, note.indexOf(fragment));
		assert.equal(note.slice(range.start, range.start + (source.length ?? 0)), fragment);
	});
});

describe("sanitizeSources", () => {
	it("passes well-formed sources through", () => {
		const sources = [
			{ label: "A", path: "A.md" },
			{ label: "B", path: "dir/B.md", anchor: "some text", length: 120 },
		];
		assert.deepEqual(sanitizeSources(sources), sources);
	});

	it("returns an empty list for anything that is not an array", () => {
		for (const bad of [undefined, null, "text", 7, {}, { 0: { label: "A", path: "A.md" } }]) {
			assert.deepEqual(sanitizeSources(bad), []);
		}
	});

	it("drops malformed entries and keeps the rest", () => {
		const out = sanitizeSources([
			null,
			"text",
			{ label: "no path" },
			{ path: "no-label.md" },
			{ label: 5, path: "A.md" },
			{ label: "   ", path: "A.md" },
			{ label: "ok", path: "ok.md" },
		]);
		assert.deepEqual(out, [{ label: "ok", path: "ok.md" }]);
	});

	it("refuses paths that are not inside the vault", () => {
		for (const path of [
			"../outside.md",
			"notes/../../outside.md",
			"notes\\..\\outside.md",
			"/etc/passwd",
			"\\\\server\\share\\x.md",
			"C:\\Users\\x\\secret.md",
			"notes/\u0000evil.md",
			"",
			"x".repeat(2000),
		]) {
			assert.deepEqual(sanitizeSources([{ label: "x", path }]), [], JSON.stringify(path));
		}
	});

	it("keeps ordinary paths, including dots in names", () => {
		for (const path of ["a.md", "dir/sub dir/Note v1.2.md", "zażółć/gęślą.md", "notes/..hidden.md"]) {
			assert.equal(sanitizeSources([{ label: "x", path }]).length, 1, path);
		}
	});

	it("caps the anchor, the label, the length and the number of sources", () => {
		const [source] = sanitizeSources([{
			label: "L".repeat(1000), path: "A.md", anchor: "a".repeat(5000), length: 10 ** 9,
		}]);
		assert.equal(source.label.length, 200);
		assert.equal(source.anchor?.length, SOURCE_ANCHOR_CHARS);
		assert.equal(source.length, 20_000);

		const many = Array.from({ length: 100 }, (_v, i) => ({ label: `n${i}`, path: `n${i}.md` }));
		assert.equal(sanitizeSources(many).length, 20);
	});

	it("ignores a mistyped anchor or length", () => {
		assert.deepEqual(
			sanitizeSources([{ label: "A", path: "A.md", anchor: 42, length: 10 }]),
			[{ label: "A", path: "A.md" }],
		);
		for (const length of ["10", NaN, Infinity, -5, 0, null]) {
			assert.deepEqual(
				sanitizeSources([{ label: "A", path: "A.md", anchor: "text", length }]),
				[{ label: "A", path: "A.md", anchor: "text" }],
			);
		}
	});

	it("copies only the known fields", () => {
		const [source] = sanitizeSources([{ label: "A", path: "A.md", chunk: "WHOLE FRAGMENT", extra: 1 }]);
		assert.deepEqual(Object.keys(source).sort(), ["label", "path"]);
	});
});

describe("sources never leave the device", () => {
	const messages: ChatMessage[] = [
		{ role: "system", content: "system" },
		{ role: "user", content: "question" },
		{
			role: "assistant", content: "answer",
			sources: [{ label: "SOURCE-LABEL", path: "private/SOURCE-PATH.md", anchor: "SOURCE-ANCHOR", length: 900 }],
		},
		{ role: "user", content: "follow-up" },
	];

	const assertClean = (body: unknown, name: string): void => {
		const json = JSON.stringify(body);
		for (const needle of ["SOURCE-LABEL", "SOURCE-PATH", "SOURCE-ANCHOR", "\"sources\"", "\"anchor\""]) {
			assert.equal(json.includes(needle), false, `${name} leaks ${needle}`);
		}
	};

	it("are stripped from every OpenAI request shape", () => {
		assertClean(buildOpenAIRequest({ model: "gpt-6-sol", messages, mode: "normal" }).body, "responses");
		assertClean(buildOpenAIRequest({ model: "gpt-4o", messages, mode: "normal" }).body, "chat completions");
		assertClean(buildOpenAIRequest({ model: "gpt-4o", messages, mode: "normal", webSearch: true }).body, "web search");
	});

	it("are stripped from every Anthropic request shape", () => {
		assertClean(buildAnthropicRequest({ model: "claude-sonnet-5-5", messages, mode: "think" }).body, "adaptive");
		assertClean(buildAnthropicRequest({ model: "claude-haiku-4-5", messages, mode: "think" }).body, "budget");
	});
});
