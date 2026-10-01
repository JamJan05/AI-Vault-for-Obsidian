/**
 * Which notes may be written is decided by the marks the user types. A mark that
 * resolved to the wrong note, or text that counted as a mark when it should not,
 * would let a change land where the user never pointed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mayWrite, parseNoteMarks, resolveWriteTargets } from "../../src/tools/writeTargets";

describe("parseNoteMarks", () => {
	it("reads #name, #folder/name and #[[name with spaces]]", () => {
		assert.deepEqual(parseNoteMarks("popraw #Plan i #Projekty/Lista oraz #[[Plan B]]"), ["plan", "projekty/lista", "plan b"]);
	});

	it("reads a mark at the very start and after a newline", () => {
		assert.deepEqual(parseNoteMarks("#Plan dopisz\n#Lista"), ["plan", "lista"]);
	});

	it("drops trailing punctuation and the .md extension", () => {
		assert.deepEqual(parseNoteMarks("zmień #Plan, potem #Lista.md. A #Trzy!"), ["plan", "lista", "trzy"]);
	});

	it("takes only the note from a wikilink with a heading or an alias", () => {
		assert.deepEqual(parseNoteMarks("#[[Plan#Cele]] #[[Lista|moja lista]]"), ["plan", "lista"]);
	});

	it("does not repeat a mark", () => {
		assert.deepEqual(parseNoteMarks("#Plan #plan #PLAN.md"), ["plan"]);
	});

	it("ignores headings, anchors inside words and URLs", () => {
		for (const text of [
			"# Heading", "## Heading", "C# is a language", "see https://example.com/page#section",
			"issue#12", "a#b", "#", "# ", "#[[]]", "[[Plan]] without a hash",
		]) {
			assert.deepEqual(parseNoteMarks(text), [], text);
		}
	});

	it("survives odd input", () => {
		assert.deepEqual(parseNoteMarks(""), []);
		assert.deepEqual(parseNoteMarks(undefined as unknown as string), []);
	});
});

describe("resolveWriteTargets", () => {
	const notes = ["Plan.md", "Projekty/Lista.md", "A/Dziennik.md", "B/Dziennik.md", "Plan B.md"];
	const resolve = (text: string): ReturnType<typeof resolveWriteTargets> =>
		resolveWriteTargets(parseNoteMarks(text), notes);

	it("resolves a bare name wherever the note is, case-insensitively", () => {
		assert.deepEqual(resolve("#plan #LISTA").paths, ["Plan.md", "Projekty/Lista.md"]);
	});

	it("resolves a path exactly", () => {
		assert.deepEqual(resolve("#Projekty/Lista").paths, ["Projekty/Lista.md"]);
		assert.deepEqual(resolve("#A/Dziennik").paths, ["A/Dziennik.md"]);
	});

	it("allows none of several notes with the same name until a folder is given", () => {
		const targets = resolve("#Dziennik");
		assert.deepEqual(targets.paths, []);
		assert.deepEqual(targets.ambiguous, ["dziennik"]);
		assert.deepEqual(targets.newNames, []);
	});

	it("does not let a note in the vault root win over one of the same name in a folder", () => {
		const targets = resolveWriteTargets(["plan"], ["Plan.md", "Projekty/Plan.md"]);
		assert.deepEqual(targets.paths, []);
		assert.deepEqual(targets.ambiguous, ["plan"]);
		assert.deepEqual(resolveWriteTargets(["projekty/plan"], ["Plan.md", "Projekty/Plan.md"]).paths, ["Projekty/Plan.md"]);
	});

	it("treats a name that matches no note as a note that may be created", () => {
		const targets = resolve("#Nowa #Projekty/Nowa");
		assert.deepEqual(targets.paths, []);
		assert.deepEqual(targets.newNames, ["nowa", "projekty/nowa"]);
	});

	it("does not match part of a name or a wrong folder", () => {
		assert.deepEqual(resolve("#Pla #Lis #X/Plan").paths, []);
	});

	it("allows nothing without marks", () => {
		assert.deepEqual(resolveWriteTargets([], notes), { paths: [], newNames: [], ambiguous: [] });
	});
});

describe("mayWrite", () => {
	const notes   = ["Plan.md", "Projekty/Lista.md", "Inne/Plan B.md"];
	const targets = resolveWriteTargets(parseNoteMarks("#Plan #Nowa #Projekty/Raport #[[Plan B]]"), notes);

	it("allows changing exactly the marked notes", () => {
		assert.equal(mayWrite(targets, "Plan.md", "edit"), true);
		assert.equal(mayWrite(targets, "Plan.md", "append"), true);
		assert.equal(mayWrite(targets, "Inne/Plan B.md", "edit"), true);
		assert.equal(mayWrite(targets, "Projekty/Lista.md", "edit"), false);
		assert.equal(mayWrite(targets, "plan.md", "edit"), false);
	});

	it("allows creating a named note in any folder, and a path-marked note only at that path", () => {
		assert.equal(mayWrite(targets, "Nowa.md", "create"), true);
		assert.equal(mayWrite(targets, "Dowolny/Folder/Nowa.md", "create"), true);
		assert.equal(mayWrite(targets, "Projekty/Raport.md", "create"), true);
		assert.equal(mayWrite(targets, "Raport.md", "create"), false);
		assert.equal(mayWrite(targets, "Inne/Raport.md", "create"), false);
		assert.equal(mayWrite(targets, "Sneaky.md", "create"), false);
	});

	it("does not let a mark for an existing note create another note of that name", () => {
		assert.equal(mayWrite(targets, "Elsewhere/Plan.md", "create"), false);
	});

	it("allows nothing with no targets", () => {
		const none = resolveWriteTargets([], notes);
		assert.equal(mayWrite(none, "Plan.md", "edit"), false);
		assert.equal(mayWrite(none, "Nowa.md", "create"), false);
	});
});
