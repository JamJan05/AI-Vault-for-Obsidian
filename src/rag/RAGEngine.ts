import { requestUrl, TFile } from "obsidian";
import { FILE_RAG_INDEX, RAG_TOP_K } from "../constants";
import {
	tokenize, buildTermFreq, chunkText,
	vectorNorm, contentHash, withRetry,
} from "../utils";
import { buildCorpusStats, queryTerms, rankEntries } from "./search";
import type { CorpusStats } from "./search";
import { parseCanvasToText } from "./canvasParser";
import {
	EMBEDDINGS_URL,
	buildEmbeddingsBody,
	canUseEmbeddings,
	parseEmbeddingsResponse,
} from "./embeddings";
import { nonRetryableError } from "../api/streaming";
import { parseRagIgnorePatterns } from "./ignorePaths";
import type { RagIgnoreMatcher } from "./ignorePaths";
import type { ExternalStorage } from "../storage/ExternalStorage";
import type { RAGEntry, RAGIndex, RAGSearchResult } from "../types";

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE    = 20;
const SAVE_DELAY_MS = 5000;
const LOG_PREFIX     = "[AI-Vault] RAG:";
/** Bumped when notes are split into fragments differently, so old indexes are rebuilt. */
const INDEX_VERSION  = 3;
/** Most fragments taken from one note for a single question. */
const MAX_FRAGMENTS_PER_NOTE = 2;

interface PluginWithDeps {
	app:             import("obsidian").App;
	externalStorage: ExternalStorage;
	settings: {
		apiKey:    string;
		ragEnabled: boolean;
		ragEmbeddingsEnabled: boolean;
		ragAutoIndex: boolean;
		ragSearchMode: "hybrid" | "semantic" | "exact" | "recent";
		ragExcludedPaths: string;
	};
}

interface RAGStats {
	files:      number;
	chunks:     number;
	embeddings: number;
}

interface PendingChunk {
	entry: RAGEntry;
	text:  string;
}

/**
 * RAG (Retrieval-Augmented Generation) engine.
 *
 * Search algorithm: BM25 (keyword) + cosine similarity (embeddings),
 * combined via Reciprocal Rank Fusion — scale-invariant, no weight tuning required.
 *
 * Improvements over the original:
 * - tokenizer handles Polish characters (Unicode \p{L})
 * - PL + EN stopwords
 * - chunking by H1/H2 headers (not just by paragraphs)
 * - RRF instead of a linear combination with arbitrary weights
 * - note-title boost in the result
 * - versioned index (_version: 2) with migration from the older format
 */
export class RAGEngine {
	private index:       RAGEntry[] = [];
	private fileHashes:  Record<string, string> = {};
	/** Word statistics of the searchable notes; rebuilt after the index or the ignore list changes. */
	private corpusStats: CorpusStats | null = null;
	/** The ignore list the statistics were built for. */
	private corpusStatsFor: string | null = null;
	/** A load in progress, shared by everyone who asks while it runs. */
	private loading: Promise<boolean> | null = null;
	private saveTimer:   number | null = null;

	indexed  = false;
	indexing = false;
	/**
	 * True when the stored index was made by an older version that split notes
	 * differently. It still works, and the next indexing run rebuilds it.
	 */
	outdated = false;

	private readonly storage: ExternalStorage;

	constructor(private readonly plugin: PluginWithDeps) {
		this.storage = plugin.externalStorage;
	}

	// ── Getters ────────────────────────────────────────────────────────────────

	private get apiKey():   string { return this.plugin.settings.apiKey; }

	/**
	 * The only gate in front of every embeddings request. Note text and questions
	 * leave the device for embedding only when the user switched semantic search on.
	 */
	get embeddingsAllowed(): boolean { return canUseEmbeddings(this.plugin.settings); }
	private get indexPath(): string { return this.storage.resolve(FILE_RAG_INDEX); }

	/** Compiled ignore list — cached per settings value, so this is cheap to call in loops. */
	private get ignored(): RagIgnoreMatcher {
		return parseRagIgnorePatterns(this.plugin.settings.ragExcludedPaths ?? "");
	}

	/** True when the path is excluded from RAG by the user's ignore list. */
	isIgnoredPath(path: string): boolean {
		return this.ignored.matches(path);
	}

	get stats(): RAGStats {
		return {
			files:      new Set(this.index.map(e => e.path)).size,
			chunks:     this.index.length,
			embeddings: this.index.filter(e => e.embedding).length,
		};
	}

	// ── Index — load / save ────────────────────────────────────────────────────

	/**
	 * Loads the index from disk once. The index in memory is the current one, so a
	 * second call — the chat view opening while startup indexing is still running —
	 * returns at once instead of replacing it with the older copy on disk.
	 */
	async loadIndex(): Promise<boolean> {
		if (this.indexed || this.indexing) return true;
		this.loading ??= this.readIndex().finally(() => { this.loading = null; });
		return this.loading;
	}

	private async readIndex(): Promise<boolean> {
		const data = await this.storage.readJson<RAGIndex | RAGEntry[] | null>(
			this.indexPath,
			null,
		);

		// Current format, or an earlier one with the same layout
		if (
			data &&
			!Array.isArray(data) &&
			(data._version === INDEX_VERSION || data._version === 2) &&
			Array.isArray(data.entries)
		) {
			const idx = data;
			this.index       = idx.entries;
			this.fileHashes  = idx.hashes ?? {};
			this.indexed     = true;
			this.outdated    = data._version !== INDEX_VERSION;
			// A stored index may predate the current ignore list — drop excluded
			// chunks before anything can read or send them.
			if (this.purgeIgnoredEntries()) this.scheduleSave();
			this.recalcAvgLen();
			for (const e of this.index) this.ensureEntryCache(e);
			return true;
		}

		// Old format (migration) — flat array
		if (Array.isArray(data) && data.length) {
			this.index       = data;
			this.fileHashes  = {};
			this.indexed     = true;
			this.outdated    = true;
			if (this.purgeIgnoredEntries()) this.scheduleSave();
			this.recalcAvgLen();
			for (const e of this.index) this.ensureEntryCache(e);
			return true;
		}

		return false;
	}

	scheduleSave(): void {
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveIndex();
		}, SAVE_DELAY_MS);
	}

	async saveIndexNow(): Promise<void> {
		if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
		await this.saveIndex();
	}

	private async saveIndex(): Promise<void> {
		// Strip cache fields (_ prefix) before saving — rebuilt during loadIndex()
		const cleanEntries = this.index.map(e => ({
			path:      e.path,
			basename:  e.basename,
			extension: e.extension,
			folder:    e.folder,
			mtime:     e.mtime,
			chunk:     e.chunk,
			tokens:    e.tokens,
			embedding: e.embedding,
		}));

		await this.storage.writeJson(this.indexPath, {
			// An index that still holds old fragments keeps its old version, so it
			// is rebuilt the next time indexing runs.
			_version: this.outdated ? 2 : INDEX_VERSION,
			entries:  cleanEntries,
			hashes:   this.fileHashes,
		} satisfies RAGIndex);
	}

	// ── Embeddings (OpenAI) ────────────────────────────────────────────────────

	private async getEmbedding(text: string): Promise<number[]> {
		const [embedding] = await this.getEmbeddingsBatch([text]);
		return embedding;
	}

	private async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
		if (!texts.length) return [];
		// Checked here as well as at the call sites: nothing reaches the network
		// through this method unless semantic search is on.
		if (!this.embeddingsAllowed) throw nonRetryableError("Semantic search is turned off");

		return withRetry(async () => {
			const r = await requestUrl({
				url:     EMBEDDINGS_URL,
				method:  "POST",
				headers: {
					"Content-Type":  "application/json",
					"Authorization": `Bearer ${this.apiKey}`,
				},
				body:  JSON.stringify(buildEmbeddingsBody(texts)),
				throw: false,
			});
			if (r.status !== 200) {
				const message = `Embedding error ${r.status}`;
				// A rejected request is not sent again; only timeouts, rate limits and
				// server errors are worth a retry.
				const retryable = r.status === 408 || r.status === 429 || r.status >= 500;
				throw retryable ? new Error(message) : nonRetryableError(message);
			}
			try {
				return parseEmbeddingsResponse(r.json, texts.length);
			} catch (e) {
				throw nonRetryableError((e as Error).message);
			}
		});
	}

	// ── Budowanie indeksu ──────────────────────────────────────────────────────

	async buildIndex(onProgress?: (done: number, total: number) => void): Promise<void> {
		if (this.indexing) return;
		this.indexing = true;

		try {
			// A full list is required here to build the user-enabled vault-wide RAG index
			// and remove index entries for deleted notes. File contents are read incrementally.
			// Ignored paths are dropped up front, so their contents are never read.
			const ignored = this.ignored;

			// Fragments are cut differently than when this index was made: forget the
			// hashes so every note is split again, and keep the vectors of fragments
			// whose text comes out the same, so nothing is sent for embedding twice.
			const oldVectors = new Map<string, number[]>();
			if (this.outdated) {
				for (const entry of this.index) {
					if (entry.embedding) oldVectors.set(`${entry.path}\u0000${entry.chunk}`, entry.embedding);
				}
				this.fileHashes = {};
			}

			const files = this.plugin.app.vault.getFiles()
				.filter((file: TFile) =>
					(file.extension === "md" || file.extension === "canvas") &&
					!ignored.matches(file.path));
			const currentPaths = new Set(files.map((f: TFile) => f.path));

			// Drop fragments of notes that are gone or are now ignored. This does not
			// rely on the hashes, which an outdated or legacy index does not have.
			this.index = this.index.filter(e => currentPaths.has(e.path));

			// Remove entries for files that no longer exist — and, because the list above
			// is already filtered, for files that are now ignored.
			const removedPaths = Object.keys(this.fileHashes).filter(p => !currentPaths.has(p));
			if (removedPaths.length) {
				const removedSet = new Set(removedPaths);
				this.index = this.index.filter(e => !removedSet.has(e.path));
				for (const p of removedPaths) delete this.fileHashes[p];
			}

			// Belt and braces: an index migrated from the legacy flat-array format has no
			// hashes, so the sweep above cannot reach its entries.
			this.purgeIgnoredEntries();

			const newHashes:     Record<string, string> = {};
			let pendingChunks:   PendingChunk[] = [];
			let done = 0;

			const embed = this.embeddingsAllowed;

			// Chunks that still need a vector, by note — built once, so unchanged
			// files do not each scan the whole index.
			const missingByPath = new Map<string, RAGEntry[]>();
			if (embed) {
				for (const entry of this.index) {
					if (entry.embedding) continue;
					const list = missingByPath.get(entry.path);
					if (list) list.push(entry);
					else missingByPath.set(entry.path, [entry]);
				}
			}

			const flushEmbeddings = async (): Promise<void> => {
				if (!pendingChunks.length || !embed) { pendingChunks = []; return; }
				try {
					const embeddings = await this.getEmbeddingsBatch(pendingChunks.map(c => c.text));
					for (let i = 0; i < embeddings.length; i++) {
						pendingChunks[i].entry.embedding  = embeddings[i];
						pendingChunks[i].entry._embNorm   = vectorNorm(embeddings[i]);
					}
				} catch (e) {
					console.warn(LOG_PREFIX, "batch embedding failed:", (e as Error)?.message);
				}
				pendingChunks = [];
			};

			for (const abstractFile of files) {
				if (!(abstractFile instanceof TFile)) {
					done++;
					onProgress?.(done, files.length);
					continue;
				}

				const file = abstractFile;
				try {
					const raw     = await this.plugin.app.vault.cachedRead(file);
					const content = file.extension === "canvas"
						? parseCanvasToText(raw, file.basename)
						: raw;
					const hash    = contentHash(content);
					newHashes[file.path] = hash;

					// Skip files that have not changed
					if (this.fileHashes[file.path] === hash) {
						// Semantic search may have been switched on after this file was
						// indexed — give its chunks the embeddings they are missing.
						if (embed) {
							for (const entry of missingByPath.get(file.path) ?? []) {
								pendingChunks.push({ entry, text: entry.chunk });
								if (pendingChunks.length >= BATCH_SIZE) await flushEmbeddings();
							}
						}
						done++;
						onProgress?.(done, files.length);
						continue;
					}

					this.index = this.index.filter(e => e.path !== file.path);
					if (!content.trim()) {
						done++;
						onProgress?.(done, files.length);
						continue;
					}

					for (const chunk of chunkText(content)) {
						const entry = this.createEntry(file, chunk);
						this.index.push(entry);

						const known = oldVectors.get(`${file.path}\u0000${chunk}`);
						if (known) {
							entry.embedding = known;
							entry._embNorm  = vectorNorm(known);
						} else if (embed) {
							pendingChunks.push({ entry, text: chunk });
							if (pendingChunks.length >= BATCH_SIZE) await flushEmbeddings();
						}
					}
				} catch (e) {
					// No fragments and no hash: nothing stale is left to be found, and
					// the note is read again the next time indexing runs.
					this.index = this.index.filter(entry => entry.path !== file.path);
					delete newHashes[file.path];
					console.warn(LOG_PREFIX, "file failed:", file.path, (e as Error)?.message);
				}

				done++;
				onProgress?.(done, files.length);
			}

			await flushEmbeddings();

			this.fileHashes = newHashes;
			this.outdated   = false;
			this.recalcAvgLen();
			await this.saveIndexNow();
			this.indexed = true;

		} finally {
			this.indexing = false;
		}
	}

	// ── Search (BM25 + cosine → RRF) ───────────────────────────────────────────

	/**
	 * Finds the fragments that best match the question — see rankEntries().
	 * Returns nothing when no fragment is related to it.
	 */
	async search(query: string, topK = RAG_TOP_K): Promise<RAGSearchResult[]> {
		if (!this.index.length) return [];

		const qt = queryTerms(query);
		if (!qt.length) return [];

		// Retrieval-time filter — covers indexes built before the current ignore list,
		// and runs before scoring so excluded chunks cannot influence the RRF ranks.
		const ignored    = this.ignored;
		const candidates = ignored.isEmpty
			? this.index
			: this.index.filter(e => !ignored.matches(e.path));
		if (!candidates.length) return [];

		const mode = this.plugin.settings.ragSearchMode ?? "hybrid";
		const useEmbedding = mode !== "exact" && this.embeddingsAllowed;

		// Optional query embedding. Without consent the question is never sent, and
		// stored vectors from an earlier opt-in simply go unused.
		let qEmb: number[] | null = null;

		if (useEmbedding && candidates.some(e => e.embedding)) {
			try {
				qEmb = await this.getEmbedding(query);
			} catch (e) {
				console.warn(LOG_PREFIX, "query embedding failed:", (e as Error)?.message);
			}
		}

		// Statistics cover exactly the notes that can be returned, so a note that
		// was just added to the ignore list no longer influences the ranking.
		const ignoreKey = this.plugin.settings.ragExcludedPaths ?? "";
		if (!this.corpusStats || this.corpusStatsFor !== ignoreKey) {
			this.corpusStats    = buildCorpusStats(candidates);
			this.corpusStatsFor = ignoreKey;
		}
		for (const e of candidates) this.ensureEntryCache(e);

		return rankEntries(candidates, qt, this.corpusStats, {
			topK,
			maxPerFile:     MAX_FRAGMENTS_PER_NOTE,
			mode,
			queryEmbedding: qEmb,
		});
	}

	// ── Incremental updates ────────────────────────────────────────────────────

	async updateFile(file: TFile): Promise<void> {
		// Bail out before the vault read and before any embedding request, so an ignored
		// note is never loaded, never sent anywhere and never re-enters the index.
		if (this.isIgnoredPath(file.path)) {
			this.removeFile(file.path);
			return;
		}

		try {
			const raw     = await this.plugin.app.vault.cachedRead(file);
			const content = file.extension === "canvas"
				? parseCanvasToText(raw, file.basename)
				: raw;
			const hash    = contentHash(content);

			if (this.fileHashes[file.path] === hash) return;

			this.index = this.index.filter(e => e.path !== file.path);
			this.fileHashes[file.path] = hash;

			if (!content.trim()) {
				this.recalcAvgLen();
				this.scheduleSave();
				return;
			}

			const newEntries = chunkText(content).map(chunk => this.createEntry(file, chunk));

			// Batch embeddings (instead of sequential requests)
			if (this.embeddingsAllowed && newEntries.length) {
				try {
					const embeddings = await this.getEmbeddingsBatch(newEntries.map(e => e.chunk));
					for (let i = 0; i < embeddings.length; i++) {
						newEntries[i].embedding = embeddings[i];
						newEntries[i]._embNorm  = vectorNorm(embeddings[i]);
					}
				} catch (e) {
					console.warn(LOG_PREFIX, "updateFile embedding failed:", (e as Error)?.message);
				}
			}

			this.index.push(...newEntries);
			this.recalcAvgLen();
			this.scheduleSave();
		} catch (e) {
			console.warn(LOG_PREFIX, "updateFile error:", file?.path, (e as Error)?.message);
		}
	}

	removeFile(filePath: string): void {
		const before = this.index.length;
		this.index = this.index.filter(e => e.path !== filePath);
		if (this.index.length === before && !this.fileHashes[filePath]) return;

		delete this.fileHashes[filePath];
		this.recalcAvgLen();
		this.scheduleSave();
	}

	renameFile(oldPath: string, newPath: string, basename: string): void {
		// Moved into an ignored location — drop the entries instead of re-pointing them.
		// The reverse case (leaving an ignored folder) is picked up by the next
		// updateFile() or a full reindex.
		if (this.isIgnoredPath(newPath)) {
			this.removeFile(oldPath);
			return;
		}

		let changed = false;
		const slash  = newPath.lastIndexOf("/");
		const folder = slash >= 0 ? newPath.slice(0, slash) : "";

		for (const e of this.index) {
			if (e.path === oldPath) {
				e.path     = newPath;
				e.basename = basename;
				e.folder   = folder;
				changed    = true;
			}
		}

		if (this.fileHashes[oldPath]) {
			this.fileHashes[newPath] = this.fileHashes[oldPath];
			delete this.fileHashes[oldPath];
			changed = true;
		}

		if (changed) this.scheduleSave();
	}

	/**
	 * Applies the current ignore list to the in-memory index and persists the result,
	 * so chunks of newly ignored notes stop being retrievable — and stop being stored —
	 * without waiting for a full reindex.
	 */
	applyIgnorePatterns(): void {
		if (!this.purgeIgnoredEntries()) return;
		this.recalcAvgLen();
		this.scheduleSave();
	}

	/**
	 * Deletes every stored embedding vector and persists the result. The keyword
	 * index is untouched, so RAG keeps working on the device.
	 * @returns the number of vectors removed
	 */
	async clearEmbeddings(): Promise<number> {
		let removed = 0;
		for (const entry of this.index) {
			if (!entry.embedding) continue;
			entry.embedding = null;
			entry._embNorm  = undefined;
			removed++;
		}
		if (removed) await this.saveIndexNow();
		return removed;
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	/** The one place an index entry is built, so a full and an incremental index agree. */
	private createEntry(file: TFile, chunk: string): RAGEntry {
		const tokens = tokenize(chunk);
		return {
			path:      file.path,
			basename:  file.basename,
			extension: file.extension,
			folder:    file.parent?.path ?? "",
			mtime:     file.stat?.mtime ?? Date.now(),
			chunk,
			tokens,
			embedding: null,
			_tf:       buildTermFreq(tokens),
		};
	}

	/**
	 * Removes index entries and hashes for paths that the ignore list now excludes.
	 * @returns true when anything was removed
	 */
	private purgeIgnoredEntries(): boolean {
		const ignored = this.ignored;
		if (ignored.isEmpty) return false;

		const before = this.index.length;
		this.index = this.index.filter(e => !ignored.matches(e.path));

		let hashesChanged = false;
		for (const path of Object.keys(this.fileHashes)) {
			if (ignored.matches(path)) {
				delete this.fileHashes[path];
				hashesChanged = true;
			}
		}

		return this.index.length !== before || hashesChanged;
	}

	/** Called after every change to the index: the word statistics are stale. */
	private recalcAvgLen(): void {
		this.corpusStats = null;
	}

	/** Ensures the entry has cache populated: TF + embeddingNorm */
	private ensureEntryCache(entry: RAGEntry): void {
		if (!entry._tf) entry._tf = buildTermFreq(entry.tokens);
		if (entry.embedding && entry._embNorm == null) {
			entry._embNorm = vectorNorm(entry.embedding);
		}
	}
}
