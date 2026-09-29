import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	EXPORT_FOLDER,
	buildExportMarkdown,
	exportBasePath,
	exportFileName,
	firstFreePath,
} from "../../src/chat/exportNote";

describe("exportFileName", () => {
	it("keeps an ordinary title", () => {
		assert.equal(exportFileName("How do I cook rice"), "How do I cook rice");
		assert.equal(exportFileName("Zażółć gęślą jaźń"), "Zażółć gęślą jaźń");
	});

	it("replaces characters that are not allowed in a file name", () => {
		assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
	});

	it("cannot escape the export folder", () => {
		for (const title of ["../../etc/passwd", "..\\..\\secret", "/absolute", "a/../../b", "....//x"]) {
			const name = exportFileName(title);
			assert.equal(name.includes("/"), false, title);
			assert.equal(name.includes("\\"), false, title);
			assert.equal(name.startsWith("."), false, title);
		}
	});

	it("replaces characters that break Obsidian links", () => {
		assert.equal(exportFileName("see [[note]] #tag ^block"), "see __note__ _tag _block");
	});

	it("collapses whitespace and cuts a long title", () => {
		assert.equal(exportFileName("a \n\t b"), "a b");
		assert.equal(exportFileName("x".repeat(200)).length, 60);
	});

	it("falls back to a name when nothing usable is left", () => {
		for (const title of ["", "   ", "...", undefined as unknown as string]) {
			assert.equal(exportFileName(title), "conversation");
		}
	});
});

describe("exportBasePath", () => {
	it("puts the note in the export folder with the date", () => {
		const path = exportBasePath("My chat", new Date("2026-09-29T10:00:00Z"));
		assert.equal(path, `${EXPORT_FOLDER}/My chat 2026-09-29`);
	});

	it("stays inside the export folder for a hostile title", () => {
		const path = exportBasePath("../../outside", new Date("2026-09-29T10:00:00Z"));
		assert.ok(path.startsWith(`${EXPORT_FOLDER}/`));
		assert.equal(path.split("/").length, 2);
		assert.equal(path.includes(".."), false);
	});
});

describe("firstFreePath", () => {
	it("uses the plain name when it is free", () => {
		assert.equal(firstFreePath("AI-Vault/chat", () => false), "AI-Vault/chat.md");
	});

	it("numbers the name until one is free, and never overwrites", () => {
		const taken = new Set(["AI-Vault/chat.md", "AI-Vault/chat (1).md", "AI-Vault/chat (2).md"]);
		const path = firstFreePath("AI-Vault/chat", candidate => taken.has(candidate));
		assert.equal(path, "AI-Vault/chat (3).md");
		assert.equal(taken.has(path), false);
	});

	it("gives up instead of looping forever", () => {
		const path = firstFreePath("AI-Vault/chat", () => true);
		assert.match(path, /^AI-Vault\/chat \(\d+\)\.md$/);
	});
});

describe("buildExportMarkdown", () => {
	const input = {
		title: "My chat", model: "gpt-6-sol", providerLabel: "GPT", date: "29.09.2026 12:00",
		messages: [
			{ role: "user" as const, content: "Question?" },
			{ role: "assistant" as const, content: "Answer.", sources: [{ label: "SECRET-LABEL", path: "private/SECRET.md", anchor: "SECRET-ANCHOR" }] },
		],
	};

	it("has a header with the title, model and date", () => {
		const markdown = buildExportMarkdown(input);
		assert.ok(markdown.startsWith("# My chat\n"));
		assert.match(markdown, /gpt-6-sol/);
		assert.match(markdown, /29\.09\.2026 12:00/);
	});

	it("writes every message in order under its speaker", () => {
		const markdown = buildExportMarkdown(input);
		const question = markdown.indexOf("Question?");
		const answer   = markdown.indexOf("Answer.");
		assert.ok(question > 0 && answer > question);
		assert.match(markdown, /\*\*You:\*\*\n\nQuestion\?/);
		assert.match(markdown, /\*\*GPT:\*\*\n\nAnswer\./);
	});

	it("falls back to the provider name when the model is unknown", () => {
		assert.match(buildExportMarkdown({ ...input, model: "" }), /Model: GPT/);
	});

	it("leaves out system messages and stored sources", () => {
		const markdown = buildExportMarkdown({
			...input,
			messages: [{ role: "system", content: "HIDDEN SYSTEM PROMPT" }, ...input.messages],
		});
		for (const marker of ["HIDDEN SYSTEM PROMPT", "SECRET-LABEL", "SECRET.md", "SECRET-ANCHOR"]) {
			assert.equal(markdown.includes(marker), false, marker);
		}
	});
});
