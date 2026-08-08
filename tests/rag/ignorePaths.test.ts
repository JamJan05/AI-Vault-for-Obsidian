import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRagIgnorePatterns } from "../../src/rag/ignorePaths";

describe("parseRagIgnorePatterns — empty list", () => {
	it("matches nothing when there are no patterns", () => {
		for (const raw of ["", "   ", "\n\n", "# only a comment\n"]) {
			const matcher = parseRagIgnorePatterns(raw);
			assert.equal(matcher.isEmpty, true);
			assert.equal(matcher.matches("Anything/note.md"), false);
		}
	});
});

describe("parseRagIgnorePatterns — folder patterns", () => {
	const matcher = parseRagIgnorePatterns("Assets/**\nPrivate");

	it("excludes everything under an explicit globstar folder", () => {
		assert.equal(matcher.matches("Assets/a.md"), true);
		assert.equal(matcher.matches("Assets/deep/nested/b.md"), true);
	});

	it("treats a wildcard-free folder name as covering its contents", () => {
		assert.equal(matcher.matches("Private"), true);
		assert.equal(matcher.matches("Private/secret.md"), true);
		assert.equal(matcher.matches("Private/sub/secret.md"), true);
	});

	it("does not exclude a folder with a shared prefix", () => {
		assert.equal(matcher.matches("Assetsx/a.md"), false);
		assert.equal(matcher.matches("PrivateStuff/a.md"), false);
	});

	it("does not exclude unrelated notes", () => {
		assert.equal(matcher.matches("Notes/a.md"), false);
	});
});

describe("parseRagIgnorePatterns — matching semantics", () => {
	it("is case-insensitive", () => {
		const matcher = parseRagIgnorePatterns("Assets/**");
		assert.equal(matcher.matches("assets/A.MD"), true);
		assert.equal(matcher.matches("ASSETS/deep/x.md"), true);
	});

	it("anchors a pattern that contains a slash at the vault root", () => {
		const matcher = parseRagIgnorePatterns("Work/Private/**");
		assert.equal(matcher.matches("Work/Private/a.md"), true);
		assert.equal(matcher.matches("Other/Work/Private/a.md"), false);
	});

	it("matches a slash-free pattern against the file name at any depth", () => {
		const matcher = parseRagIgnorePatterns("secret.md");
		assert.equal(matcher.matches("secret.md"), true);
		assert.equal(matcher.matches("a/b/c/secret.md"), true);
		assert.equal(matcher.matches("a/b/not-secret.md"), false);
	});

	it("keeps * inside one segment and lets ** cross segments", () => {
		const single = parseRagIgnorePatterns("Work/*.md");
		assert.equal(single.matches("Work/a.md"), true);
		assert.equal(single.matches("Work/sub/a.md"), false);

		const cross = parseRagIgnorePatterns("Work/**/*.md");
		assert.equal(cross.matches("Work/sub/a.md"), true);
	});

	it("matches an extension pattern at any depth", () => {
		const matcher = parseRagIgnorePatterns("*.canvas");
		assert.equal(matcher.matches("board.canvas"), true);
		assert.equal(matcher.matches("a/b/board.canvas"), true);
		assert.equal(matcher.matches("a/b/board.md"), false);
	});

	it("normalizes backslashes and leading slashes in the path under test", () => {
		const matcher = parseRagIgnorePatterns("Assets/**");
		assert.equal(matcher.matches("\\Assets\\a.md"), true);
		assert.equal(matcher.matches("/Assets//a.md"), true);
		assert.equal(matcher.matches("./Assets/a.md"), true);
	});
});

describe("parseRagIgnorePatterns — robustness", () => {
	it("skips comments and blank lines", () => {
		const matcher = parseRagIgnorePatterns("# comment\n\n  \nAssets/**\n# trailing");
		assert.equal(matcher.matches("Assets/a.md"), true);
		assert.equal(matcher.matches("comment/a.md"), false);
	});

	it("keeps working when one pattern is invalid", () => {
		// A malformed pattern must never disable the whole ignore list.
		const matcher = parseRagIgnorePatterns("[unclosed\nAssets/**");
		assert.equal(matcher.matches("Assets/a.md"), true);
	});

	it("returns false for an empty path", () => {
		const matcher = parseRagIgnorePatterns("Assets/**");
		assert.equal(matcher.matches(""), false);
	});

	it("re-parses when the pattern text changes", () => {
		const first = parseRagIgnorePatterns("A/**");
		assert.equal(first.matches("A/x.md"), true);
		const second = parseRagIgnorePatterns("B/**");
		assert.equal(second.matches("A/x.md"), false);
		assert.equal(second.matches("B/x.md"), true);
	});
});
