/**
 * Ranking for RAG search.
 *
 * Free of Obsidian imports. It decides which note fragments are put into a
 * prompt, so it is unit tested as written — including the rule that a fragment
 * with no relation to the question is never returned.
 */

import { cosineSim, tokenize } from "../utils";
import type { RAGSearchResult } from "../types";
import type { RAGSearchMode } from "../settings";

export interface SearchableEntry {
	path:       string;
	basename:   string;
	chunk:      string;
	tokens:     string[];
	embedding?: number[] | null;
	mtime?:     number;
	_tf?:       Record<string, number>;
	_embNorm?:  number | null;
}

export interface CorpusStats {
	/** Number of fragments. */
	size:   number;
	/** Average fragment length in tokens. */
	avgLen: number;
	/** In how many fragments each token occurs. */
	df:     Map<string, number>;
}

export interface RankOptions {
	topK:            number;
	/** Most fragments taken from one note. */
	maxPerFile:      number;
	mode:            RAGSearchMode;
	queryEmbedding?: number[] | null;
	now?:            number;
}

/** Weight of a word that matches by stem rather than exactly. */
const STEM_WEIGHT = 0.6;
/** Shortest shared beginning that counts as the same stem. */
const MIN_STEM = 4;
/** Longest ending two forms of a word may differ by. */
const MAX_ENDING = 2;
/** A fragment with fewer words than this is scored down: it says too little to be an answer. */
const FULL_LENGTH_TOKENS = 12;
/** An embedding this close or closer counts as related to the question. */
const MIN_COSINE = 0.25;
/** Reciprocal rank fusion constant. */
const RRF_K = 60;
const TITLE_BOOST = 0.05;
const RECENCY_BOOST = 0.02;
const K1 = 1.5;
const B = 0.75;

/**
 * Words that say what to do with the notes, not what they are about. Searching
 * for them finds notes that merely contain the word "notes" or "summary".
 */
const REQUEST_WORDS: readonly string[] = [
	// Polish
	"streszcz", "streszczenie", "podsumuj", "podsumowanie", "opisz", "opowiedz", "powiedz",
	"napisz", "wyjaśnij", "wytłumacz", "pokaż", "znajdź", "wymień", "proszę", "wiesz",
	"notatka", "notatki", "notatek", "notatkach", "notatce", "moje", "moich", "moją", "mojej",
	"wszystko", "wszystkie", "temat", "czym", "jakie", "jaki", "jaka", "które",
	// English
	"summarize", "summarise", "summary", "describe", "explain", "tell", "show", "list",
	"find", "please", "about", "know", "note", "notes", "everything", "what", "which",
];

/** The words of a question that say what it is about. */
export function queryTerms(query: string): string[] {
	return tokenize(query).filter(token => !REQUEST_WORDS.some(word => sharesStem(token, word)));
}

export function buildCorpusStats(entries: readonly SearchableEntry[]): CorpusStats {
	const df = new Map<string, number>();
	let tokens = 0;

	for (const entry of entries) {
		tokens += entry.tokens.length;
		for (const token of new Set(entry.tokens)) df.set(token, (df.get(token) ?? 0) + 1);
	}
	return { size: entries.length, avgLen: entries.length ? tokens / entries.length : 0, df };
}

/**
 * True when two words are forms of the same word: "kosmos" and "kosmosie",
 * "note" and "notes". They must share a beginning of at least four letters and
 * differ only in a short ending — "plan" and "planeta" are different words.
 */
export function sharesStem(a: string, b: string): boolean {
	if (a === b) return true;
	const longest = Math.max(a.length, b.length);
	const needed  = Math.max(MIN_STEM, longest - MAX_ENDING);
	if (Math.min(a.length, b.length) < needed) return false;

	for (let i = 0; i < needed; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * The words to look for, with a weight each: the words of the question, and the
 * words in the notes that are other forms of them.
 */
export function expandQuery(queryTokens: readonly string[], stats: CorpusStats): Map<string, number> {
	const weights = new Map<string, number>();
	const unique  = [...new Set(queryTokens)];

	for (const token of unique) {
		if (stats.df.has(token)) weights.set(token, 1);
	}
	for (const word of stats.df.keys()) {
		if (weights.has(word)) continue;
		if (unique.some(token => sharesStem(token, word))) weights.set(word, STEM_WEIGHT);
	}
	return weights;
}

function idf(token: string, stats: CorpusStats): number {
	const df = stats.df.get(token) ?? 0;
	return Math.log(1 + (stats.size - df + 0.5) / (df + 0.5));
}

function termFrequencies(entry: SearchableEntry): Record<string, number> {
	if (entry._tf) return entry._tf;
	const tf: Record<string, number> = {};
	for (const token of entry.tokens) tf[token] = (tf[token] ?? 0) + 1;
	return tf;
}

/** BM25 with inverse document frequency, so a rare word counts for more than a common one. */
export function lexicalScore(
	weights: ReadonlyMap<string, number>,
	entry:   SearchableEntry,
	stats:   CorpusStats,
): number {
	if (!weights.size) return 0;
	const tf      = termFrequencies(entry);
	const lenNorm = 1 - B + B * entry.tokens.length / Math.max(stats.avgLen, 1);

	let score = 0;
	for (const [token, weight] of weights) {
		const count = tf[token];
		if (!count) continue;
		score += weight * idf(token, stats) * (count * (K1 + 1)) / (count + K1 * lenNorm);
	}

	// BM25 favours short fragments, and the shortest of all is a bare heading.
	const brevity = Math.min(1, entry.tokens.length / FULL_LENGTH_TOKENS);
	return score * brevity;
}

function ranks<T>(items: readonly T[], score: (item: T) => number): Map<T, number> {
	const sorted = [...items].sort((a, b) => score(b) - score(a));
	return new Map(sorted.map((item, index) => [item, index]));
}

/**
 * Picks the fragments that best answer the question.
 *
 * A fragment is only a candidate when it is related to the question: it shares a
 * word with it, its note is named after it, or its embedding is close to it.
 * When nothing is related the result is empty — an unrelated fragment is never
 * sent just to fill the list.
 */
export function rankEntries(
	entries:     readonly SearchableEntry[],
	queryTokens: readonly string[],
	stats:       CorpusStats,
	options:     RankOptions,
): RAGSearchResult[] {
	if (!entries.length || !queryTokens.length || options.topK <= 0) return [];

	const qEmb       = options.queryEmbedding ?? null;
	const useLexical = options.mode !== "semantic" || !qEmb;
	const weights    = expandQuery(queryTokens, stats);
	const titleCache = new Map<string, number>();

	const titleMatch = (basename: string): number => {
		let value = titleCache.get(basename);
		if (value === undefined) {
			const titleTokens = tokenize(basename);
			const hits = queryTokens.filter(q => titleTokens.some(title => sharesStem(q, title))).length;
			value = hits / queryTokens.length;
			titleCache.set(basename, value);
		}
		return value;
	};

	const scored = entries
		.map(entry => ({
			entry,
			lexical: useLexical ? lexicalScore(weights, entry, stats) : 0,
			cosine:  qEmb && entry.embedding
				? cosineSim(qEmb, entry.embedding, undefined, entry._embNorm ?? undefined)
				: 0,
			title:   titleMatch(entry.basename),
		}))
		.filter(s => s.lexical > 0 || s.title > 0 || s.cosine >= MIN_COSINE);

	if (!scored.length) return [];

	const byLexical = ranks(scored, s => s.lexical);
	const byCosine  = ranks(scored, s => s.cosine);
	const now       = options.now ?? Date.now();

	const results = scored.map(s => {
		let score = 0;
		if (s.lexical > 0) score += 1 / (RRF_K + (byLexical.get(s) ?? 0));
		if (s.cosine > 0)  score += 1 / (RRF_K + (byCosine.get(s) ?? 0));
		score += TITLE_BOOST * s.title;

		if (options.mode === "recent" && s.entry.mtime) {
			const ageDays = Math.max(0, (now - s.entry.mtime) / 86_400_000);
			score += RECENCY_BOOST * Math.max(0, 1 - ageDays / 365);
		}
		return {
			path: s.entry.path, basename: s.entry.basename, chunk: s.entry.chunk, score,
			named: s.title > 0,
		};
	});

	results.sort((a, b) => b.score - a.score);

	const perFile = new Map<string, number>();
	const picked: RAGSearchResult[] = [];
	for (const { named, ...result } of results) {
		// A note the question names is the subject itself, so more of it is taken.
		const limit = named ? options.maxPerFile * 2 : options.maxPerFile;
		const taken = perFile.get(result.path) ?? 0;
		if (taken >= limit) continue;
		perFile.set(result.path, taken + 1);
		picked.push(result);
		if (picked.length >= options.topK) break;
	}
	return picked;
}
