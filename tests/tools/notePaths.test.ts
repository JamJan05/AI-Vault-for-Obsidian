/**
 * A model names the note it wants to read or change. These rules decide which
 * files it can reach at all, so every way out of "a Markdown note in the vault"
 * is tested.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveNotePath } from "../../src/tools/notePaths";

const resolve = (raw: unknown, configDir = ".obsidian"): ReturnType<typeof resolveNotePath> =>
	resolveNotePath(raw, configDir);

describe("resolveNotePath", () => {
	it("accepts Markdown notes inside the vault", () => {
		for (const path of ["Note.md", "Folder/Note.md", "A/B/C/Zażółć gęślą.md", "Notes v1.2.md", "x.MD"]) {
			assert.deepEqual(resolve(path), { ok: true, path }, path);
		}
	});

	it("trims surrounding whitespace", () => {
		assert.deepEqual(resolve("  Folder/Note.md \n"), { ok: true, path: "Folder/Note.md" });
	});

	it("refuses anything that is not a string", () => {
		for (const raw of [undefined, null, 42, {}, ["Note.md"]]) {
			assert.equal(resolve(raw).ok, false);
		}
	});

	it("refuses paths that leave the vault", () => {
		for (const path of [
			"../secret.md", "Folder/../../secret.md", "Folder/./Note.md", "/etc/passwd.md",
			"/Note.md", "C:/Users/me/Note.md", "C:\\Users\\me\\Note.md", "Folder\\Note.md",
			"..\\Note.md", "Folder//Note.md", "",  "   ",
		]) {
			assert.equal(resolve(path).ok, false, path);
		}
	});

	it("refuses hidden folders and the configuration folder", () => {
		for (const path of [
			".obsidian/plugins/ai-vault/data.md", ".obsidian/app.md", ".git/config.md",
			".trash/Note.md", "Folder/.hidden/Note.md", ".Note.md", "Folder/.md",
		]) {
			assert.equal(resolve(path).ok, false, path);
		}
	});

	it("refuses a configuration folder that has been renamed", () => {
		assert.equal(resolve("config/app.md", "config").ok, false);
		assert.equal(resolve("Config/app.md", "config").ok, false);
		assert.equal(resolve("config.md", "config").ok, true);
		assert.equal(resolve("configuration/app.md", "config").ok, true);
	});

	it("refuses files that are not Markdown notes", () => {
		for (const path of ["data.json", "Note", "Note.md.json", "Board.canvas", "Folder/", "image.png", "Note.md/"]) {
			assert.equal(resolve(path).ok, false, path);
		}
	});

	it("refuses control characters and characters not allowed in file names", () => {
		for (const path of ["No\u0000te.md", "No\nte.md", "No:te.md", "No*te.md", "No?te.md", "a|b.md", "<x>.md", "\"x\".md"]) {
			assert.equal(resolve(path).ok, false, JSON.stringify(path));
		}
	});

	it("refuses overlong paths", () => {
		assert.equal(resolve("a".repeat(1100) + ".md").ok, false);
	});

	it("always gives a reason", () => {
		const result = resolve("../x.md");
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.reason.length > 0);
	});
});

describe("resolveNotePath — canvases", () => {
	it("accepts only .canvas files when a canvas is asked for", () => {
		assert.deepEqual(resolveNotePath("Maps/Plan.canvas", ".obsidian", ".canvas"), { ok: true, path: "Maps/Plan.canvas" });
		for (const path of ["Plan.md", "Plan", "Plan.canvas.json", ".canvas", "Maps/.canvas"]) {
			assert.equal(resolveNotePath(path, ".obsidian", ".canvas").ok, false, path);
		}
	});

	it("applies the same containment rules as for notes", () => {
		for (const path of ["../Plan.canvas", "/Plan.canvas", ".obsidian/Plan.canvas", ".hidden/Plan.canvas", "a\\Plan.canvas"]) {
			assert.equal(resolveNotePath(path, ".obsidian", ".canvas").ok, false, path);
		}
	});

	it("does not accept a canvas where a note is asked for", () => {
		const result = resolveNotePath("Plan.canvas", ".obsidian");
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /read_canvas/);
	});
});
