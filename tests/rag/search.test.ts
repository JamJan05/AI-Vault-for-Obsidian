/**
 * Ranking decides which note fragments are put into a prompt and sent to a
 * provider. The most important rule: a fragment unrelated to the question is
 * never returned just to fill the list.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildCorpusStats,
	expandQuery,
	lexicalScore,
	queryTerms,
	rankEntries,
	sharesStem,
} from "../../src/rag/search";
import { tokenize } from "../../src/utils";
import type { RankOptions, SearchableEntry } from "../../src/rag/search";

const entry = (path: string, chunk: string, extra: Partial<SearchableEntry> = {}): SearchableEntry => ({
	path,
	basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
	chunk,
	tokens: tokenize(chunk),
	...extra,
});

const OPTIONS: RankOptions = { topK: 5, maxPerFile: 2, mode: "hybrid" };

const search = (entries: SearchableEntry[], query: string, options: Partial<RankOptions> = {}) =>
	rankEntries(entries, queryTerms(query), buildCorpusStats(entries), { ...OPTIONS, ...options });

const VAULT = [
	entry("Kosmos.md", "# Kosmos\n\nWszechświat rozszerza się od Wielkiego Wybuchu, a galaktyki oddalają się od siebie."),
	entry("Atmosfera.md", "# Atmosfera\n\nAtmosfera Ziemi składa się głównie z azotu i tlenu, a jej warstwy to troposfera i stratosfera."),
	entry("Przepisy/Pierogi.md", "# Pierogi\n\nCiasto na pierogi robi się z mąki, wody i szczypty soli."),
	entry("Praca/Plan.md", "# Plan tygodnia\n\nW poniedziałek spotkanie zespołu, we wtorek przegląd budżetu."),
];

describe("sharesStem", () => {
	it("matches forms of the same word", () => {
		const pairs: Array<[string, string]> = [
			["kosmos", "kosmosie"], ["kosmos", "kosmosu"], ["atmosfera", "atmosferze"],
			["notatka", "notatki"], ["pierogi", "pierogów"], ["note", "notes"], ["planet", "planets"],
		];
		for (const [a, b] of pairs) {
			assert.equal(sharesStem(a, b), true, `${a} / ${b}`);
			assert.equal(sharesStem(b, a), true, `${b} / ${a}`);
		}
	});

	it("does not match different words that merely start alike", () => {
		const pairs: Array<[string, string]> = [
			["praca", "pracownik"], ["kos", "kosmos"], ["plan", "planeta"], ["note", "notebook"],
			["kot", "koty"], ["atmosfera", "atmosferyczny"], ["woda", "wodospad"],
		];
		for (const [a, b] of pairs) assert.equal(sharesStem(a, b), false, `${a} / ${b}`);
	});

	it("matches identical words of any length", () => {
		assert.equal(sharesStem("kot", "kot"), true);
	});
});

describe("expandQuery", () => {
	const stats = buildCorpusStats(VAULT);

	it("gives an exact word full weight and another form a lower one", () => {
		const weights = expandQuery(["atmosfera", "kosmosie"], stats);
		assert.equal(weights.get("atmosfera"), 1);
		assert.equal(weights.get("kosmos"), 0.6);
	});

	it("contains only words that occur in the notes", () => {
		const weights = expandQuery(["kosmosie", "nieistniejące"], stats);
		for (const word of weights.keys()) assert.ok(stats.df.has(word), word);
	});

	it("is empty when nothing in the notes matches", () => {
		assert.equal(expandQuery(["streszcz", "proszę"], stats).size, 0);
	});
});

describe("lexicalScore", () => {
	it("counts a rare word for more than a common one", () => {
		const entries = [
			entry("a.md", "common rare filler filler filler"),
			entry("b.md", "common other filler filler filler"),
			entry("c.md", "common third filler filler filler"),
		];
		const stats = buildCorpusStats(entries);
		const rare   = lexicalScore(new Map([["rare", 1]]), entries[0], stats);
		const common = lexicalScore(new Map([["common", 1]]), entries[0], stats);
		assert.ok(rare > common);
	});

	it("is zero without a matching word and finite for an empty fragment", () => {
		const stats = buildCorpusStats(VAULT);
		assert.equal(lexicalScore(new Map([["pierogi", 1]]), VAULT[0], stats), 0);
		assert.equal(lexicalScore(new Map(), VAULT[0], stats), 0);
		assert.ok(Number.isFinite(lexicalScore(new Map([["x", 1]]), entry("e.md", ""), buildCorpusStats([]))));
	});
});

describe("rankEntries — nothing unrelated is ever returned", () => {
	it("returns nothing for a question that matches no note", () => {
		assert.deepEqual(search(VAULT, "streszcz mi proszę wszystko"), []);
		assert.deepEqual(search(VAULT, "quantum chromodynamics lecture"), []);
	});

	it("returns only the notes that are related", () => {
		const results = search(VAULT, "z czego składa się atmosfera");
		assert.deepEqual(results.map(r => r.path), ["Atmosfera.md"]);
	});

	it("never pads the list up to topK", () => {
		const results = search(VAULT, "pierogi", { topK: 5 });
		assert.equal(results.length, 1);
	});

	it("returns nothing for an empty index, an empty question or topK 0", () => {
		assert.deepEqual(search([], "kosmos"), []);
		assert.deepEqual(search(VAULT, ""), []);
		assert.deepEqual(search(VAULT, "!!! ???"), []);
		assert.deepEqual(search(VAULT, "kosmos", { topK: 0 }), []);
	});
});

describe("rankEntries — finding notes", () => {
	it("finds a note by an inflected form of its topic", () => {
		assert.equal(search(VAULT, "opowiedz o kosmosie")[0]?.path, "Kosmos.md");
		assert.equal(search(VAULT, "notatka o atmosferze")[0]?.path, "Atmosfera.md");
	});

	it("finds several notes named in one question", () => {
		const paths = search(VAULT, "kosmos atmosfera").map(r => r.path).sort();
		assert.deepEqual(paths, ["Atmosfera.md", "Kosmos.md"]);
	});

	it("returns the text of the fragment, not just a title", () => {
		const [result] = search(VAULT, "kosmos");
		assert.ok(result.chunk.includes("Wszechświat rozszerza się"));
	});

	it("finds a note by its title even when the text does not repeat it", () => {
		const entries = [
			entry("Fotosynteza.md", "Rośliny zamieniają światło w energię chemiczną w chloroplastach."),
			entry("Inne.md", "Zupełnie inny temat bez związku."),
		];
		assert.deepEqual(search(entries, "fotosynteza").map(r => r.path), ["Fotosynteza.md"]);
	});

	it("prefers the fragment with the content over a bare heading", () => {
		const entries = [
			entry("Kosmos.md", "# Kosmos"),
			entry("Kosmos.md", "Kosmos to przestrzeń poza atmosferą Ziemi, kosmos jest niemal pusty i bardzo zimny."),
			entry("Inne.md", "Zupełnie inny temat bez związku z pytaniem."),
		];
		const [best] = search(entries, "kosmos", { maxPerFile: 1 });
		assert.ok(best.chunk.includes("przestrzeń"));
	});
});

describe("rankEntries — limits", () => {
	const many = Array.from({ length: 10 }, (_v, i) =>
		entry("Kosmos.md", `Fragment ${i} o tym, czym jest kosmos i jak go badamy, wersja numer ${i}.`));

	it("takes at most maxPerFile fragments from a note the question does not name", () => {
		const unnamed = many.map(e => ({ ...e, path: "Dziennik.md", basename: "Dziennik" }));
		assert.equal(search(unnamed, "kosmos", { maxPerFile: 2 }).length, 2);
		assert.equal(search(unnamed, "kosmos", { maxPerFile: 1 }).length, 1);
	});

	it("takes twice as many from a note the question names", () => {
		assert.equal(search(many, "kosmos", { maxPerFile: 2 }).length, 4);
		assert.equal(search(many, "streszcz notatki o kosmosie", { maxPerFile: 2 }).length, 4);
	});

	it("never exceeds topK, even for a named note", () => {
		assert.equal(search(many, "kosmos", { maxPerFile: 5, topK: 5 }).length, 5);
	});

	it("returns only the documented fields", () => {
		const [result] = search(many, "kosmos");
		assert.deepEqual(Object.keys(result).sort(), ["basename", "chunk", "path", "score"]);
	});

	it("returns at most topK fragments", () => {
		const entries = Array.from({ length: 20 }, (_v, i) => entry(`n${i}.md`, `Notatka ${i} o tym, czym jest kosmos.`));
		assert.equal(search(entries, "kosmos", { topK: 5 }).length, 5);
	});

	it("orders results by score, best first", () => {
		const results = search(VAULT, "kosmos atmosfera pierogi");
		for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].score >= results[i].score);
	});
});

describe("rankEntries — embeddings", () => {
	const entries = [
		entry("Close.md", "alpha beta gamma", { embedding: [1, 0, 0] }),
		entry("Far.md", "delta epsilon zeta", { embedding: [0, 1, 0] }),
	];

	it("finds a related note that shares no word with the question", () => {
		const results = search(entries, "unrelated wording", { queryEmbedding: [0.9, 0.1, 0] });
		assert.deepEqual(results.map(r => r.path), ["Close.md"]);
	});

	it("drops a note whose embedding is not close enough", () => {
		const results = search(entries, "unrelated wording", { queryEmbedding: [0, 0, 1] });
		assert.deepEqual(results, []);
	});

	it("ignores stored embeddings when no question embedding is given", () => {
		assert.deepEqual(search(entries, "unrelated wording"), []);
	});

	it("falls back to keywords in semantic mode without a question embedding", () => {
		const results = search(entries, "gamma", { mode: "semantic" });
		assert.deepEqual(results.map(r => r.path), ["Close.md"]);
	});

	it("uses embeddings only, in semantic mode with a question embedding", () => {
		const results = search(entries, "delta", { mode: "semantic", queryEmbedding: [1, 0, 0] });
		assert.deepEqual(results.map(r => r.path), ["Close.md"]);
	});
});

describe("rankEntries — recent mode", () => {
	it("prefers the newer of two equally good notes", () => {
		const now = Date.UTC(2026, 8, 29);
		const entries = [
			entry("Old.md", "Notatka o tym, czym jest kosmos.", { mtime: now - 400 * 86_400_000 }),
			entry("New.md", "Notatka o tym, czym jest kosmos.", { mtime: now - 86_400_000 }),
		];
		assert.equal(search(entries, "kosmos", { mode: "recent", now })[0].path, "New.md");
	});
});

describe("queryTerms", () => {
	it("keeps the topic and drops the words of the request", () => {
		assert.deepEqual(queryTerms("streszcz notatki o kosmosie"), ["kosmosie"]);
		assert.deepEqual(queryTerms("co wiesz o atmosferze?"), ["atmosferze"]);
		assert.deepEqual(queryTerms("Please summarize my notes about photosynthesis"), ["photosynthesis"]);
		assert.deepEqual(queryTerms("opowiedz mi o pierogach i barszczu"), ["pierogach", "barszczu"]);
	});

	it("is empty for a request that names no topic", () => {
		for (const query of ["streszcz mi moje notatki", "podsumuj wszystkie notatki", "summarize my notes", "tell me everything", ""]) {
			assert.deepEqual(queryTerms(query), [], query);
		}
	});

	it("does not drop a topic that only starts like a request word", () => {
		assert.deepEqual(queryTerms("notebook"), ["notebook"]);
		assert.deepEqual(queryTerms("tematyka kosmiczna"), ["tematyka", "kosmiczna"]);
	});
});

describe("rankEntries — a request without a topic", () => {
	it("finds nothing, even when notes contain the words of the request", () => {
		const entries = [
			...VAULT,
			entry("Meta.md", "Moje notatki i streszczenie tego, jak robię notatki oraz podsumowanie tygodnia."),
		];
		assert.deepEqual(search(entries, "streszcz mi moje notatki"), []);
	});

	it("still finds the topic when the request names one", () => {
		const entries = [
			...VAULT,
			entry("Meta.md", "Moje notatki i streszczenie tego, jak robię notatki oraz podsumowanie tygodnia."),
		];
		assert.deepEqual(search(entries, "streszcz notatki o kosmosie").map(r => r.path), ["Kosmos.md"]);
	});
});
