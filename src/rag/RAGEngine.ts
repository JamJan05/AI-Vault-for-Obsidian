import { requestUrl } from "obsidian";
import type { TFile } from "obsidian";
import { RAG_TOP_K } from "../constants";
import {
	tokenize, buildTermFreq, chunkText,
	bm25Score, cosineSim, vectorNorm,
	contentHash, withRetry,
} from "../utils";
import { parseCanvasToText } from "./canvasParser";
import type { ExternalStorage } from "../storage/ExternalStorage";
import type { RAGEntry, RAGIndex, RAGSearchResult } from "../types";

// ─── Constants ────────────────────────────────────────────────────────────────

const BATCH_SIZE    = 20;
const SAVE_DELAY_MS = 5000;
const FILE_RAG_INDEX = "rag-index.json";

interface PluginWithDeps {
	app:             import("obsidian").App;
	externalStorage: ExternalStorage;
	settings: {
		apiKey:    string;
		ragAutoIndex: boolean;
		ragSearchMode: "hybrid" | "semantic" | "exact" | "recent";
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
	private cachedAvgLen = 0;
	private saveTimer:   number | null = null;

	indexed  = false;
	indexing = false;

	private readonly storage: ExternalStorage;

	constructor(private readonly plugin: PluginWithDeps) {
		this.storage = plugin.externalStorage;
	}

	// ── Getters ────────────────────────────────────────────────────────────────

	private get apiKey():   string { return this.plugin.settings.apiKey; }
	private get indexPath(): string { return this.storage.resolve(FILE_RAG_INDEX); }

	get stats(): RAGStats {
		return {
			files:      new Set(this.index.map(e => e.path)).size,
			chunks:     this.index.length,
			embeddings: this.index.filter(e => e.embedding).length,
		};
	}

	// ── Index — load / save ────────────────────────────────────────────────────

	async loadIndex(): Promise<boolean> {
		const data = await this.storage.readJson<RAGIndex | RAGEntry[] | null>(
			this.indexPath,
			null,
		);

		// v2 format
		if (
			data &&
			!Array.isArray(data) &&
			(data as RAGIndex)._version === 2 &&
			Array.isArray((data as RAGIndex).entries)
		) {
			const idx = data as RAGIndex;
			this.index       = idx.entries;
			this.fileHashes  = idx.hashes ?? {};
			this.indexed     = true;
			this.recalcAvgLen();
			for (const e of this.index) this.ensureEntryCache(e);
			return true;
		}

		// Old format (migration) — flat array
		if (Array.isArray(data) && data.length) {
			this.index       = data as RAGEntry[];
			this.fileHashes  = {};
			this.indexed     = true;
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
			_version: 2,
			entries:  cleanEntries,
			hashes:   this.fileHashes,
		} satisfies RAGIndex);
	}

	// ── Embeddings (OpenAI) ────────────────────────────────────────────────────

	private async getEmbedding(text: string): Promise<number[]> {
		return withRetry(async () => {
			const r = await requestUrl({
				url:     "https://api.openai.com/v1/embeddings",
				method:  "POST",
				headers: {
					"Content-Type":  "application/json",
					"Authorization": `Bearer ${this.apiKey}`,
				},
				body:  JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
				throw: false,
			});
			if (r.status !== 200) throw new Error(`Embedding error ${r.status}`);
			return (r.json as { data: { embedding: number[] }[] }).data[0].embedding;
		});
	}

	private async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
		if (!texts.length) return [];
		return withRetry(async () => {
			const r = await requestUrl({
				url:     "https://api.openai.com/v1/embeddings",
				method:  "POST",
				headers: {
					"Content-Type":  "application/json",
					"Authorization": `Bearer ${this.apiKey}`,
				},
				body:  JSON.stringify({
					model: "text-embedding-3-small",
					input: texts.map(t => t.slice(0, 8000)),
				}),
				throw: false,
			});
			if (r.status !== 200) throw new Error(`Embedding error ${r.status}`);
			return (r.json as { data: { embedding: number[] }[] }).data.map(d => d.embedding);
		});
	}

	// ── Budowanie indeksu ──────────────────────────────────────────────────────

	async buildIndex(onProgress?: (done: number, total: number) => void): Promise<void> {
		if (this.indexing) return;
		this.indexing = true;

		try {
			const mdFiles     = this.plugin.app.vault.getMarkdownFiles();
			const canvasFiles = this.plugin.app.vault.getFiles()
				.filter((f: TFile) => f.extension === "canvas");
			const files       = [...mdFiles, ...canvasFiles];
			const currentPaths = new Set(files.map((f: TFile) => f.path));

			// Remove entries for files that no longer exist
			const removedPaths = Object.keys(this.fileHashes).filter(p => !currentPaths.has(p));
			if (removedPaths.length) {
				const removedSet = new Set(removedPaths);
				this.index = this.index.filter(e => !removedSet.has(e.path));
				for (const p of removedPaths) delete this.fileHashes[p];
			}

			const newHashes:     Record<string, string> = {};
			let pendingChunks:   PendingChunk[] = [];
			let done = 0, skipped = 0, reindexed = 0;

			const flushEmbeddings = async (): Promise<void> => {
				if (!pendingChunks.length || !this.apiKey) { pendingChunks = []; return; }
				try {
					const embeddings = await this.getEmbeddingsBatch(pendingChunks.map(c => c.text));
					for (let i = 0; i < embeddings.length; i++) {
						pendingChunks[i].entry.embedding  = embeddings[i];
						pendingChunks[i].entry._embNorm   = vectorNorm(embeddings[i]);
					}
				} catch (e) {
					console.warn("[GPT RAG] batch embedding failed:", (e as Error)?.message);
				}
				pendingChunks = [];
			};

			for (const file of files) {
				try {
					const raw     = await this.plugin.app.vault.cachedRead(file as TFile);
					const content = (file as TFile).extension === "canvas"
						? parseCanvasToText(raw, (file as TFile).basename)
						: raw;
					const hash    = contentHash(content);
					newHashes[(file as TFile).path] = hash;

					// Skip files that have not changed
					if (this.fileHashes[(file as TFile).path] === hash) {
						skipped++;
						done++;
						onProgress?.(done, files.length);
						continue;
					}

					this.index = this.index.filter(e => e.path !== (file as TFile).path);
					if (!content.trim()) { done++; continue; }
					reindexed++;

					for (const chunk of chunkText(content)) {
						const tokens = tokenize(chunk);
						const entry: RAGEntry = {
							path:      (file as TFile).path,
							basename:  (file as TFile).basename,
							chunk,
							tokens,
							embedding: null,
							_tf:       buildTermFreq(tokens),
						};
						this.index.push(entry);

						if (this.apiKey) {
							pendingChunks.push({ entry, text: chunk });
							if (pendingChunks.length >= BATCH_SIZE) await flushEmbeddings();
						}
					}
				} catch (e) {
					console.warn("[GPT RAG] file failed:", (file as TFile).path, (e as Error)?.message);
				}

				done++;
				onProgress?.(done, files.length);
			}

			await flushEmbeddings();

			this.fileHashes = newHashes;
			this.recalcAvgLen();
			await this.saveIndexNow();
			this.indexed = true;

			console.info(
				`[GPT RAG] Incremental: ${reindexed} reindexed,`,
				`${skipped} skipped, ${removedPaths.length} removed`,
			);
		} finally {
			this.indexing = false;
		}
	}

	// ── Search (BM25 + cosine → RRF) ───────────────────────────────────────────

	/**
	 * Finds the chunks that best match the query.
	 * Algorithm: BM25 + cosine similarity combined via Reciprocal Rank Fusion.
	 * RRF is scale-invariant — no manual weight tuning needed.
	 */
	async search(query: string, topK = RAG_TOP_K): Promise<RAGSearchResult[]> {
		if (!this.index.length) return [];

		const qt     = tokenize(query);
		if (!qt.length) return [];

		const avgLen = this.cachedAvgLen;
		const mode = this.plugin.settings.ragSearchMode ?? "hybrid";
		const useEmbedding = mode !== "exact";
		const useLexical = mode !== "semantic";


		// Optional query embedding
		let qEmb:  number[] | null = null;
		let qNorm  = 0;

		if (useEmbedding && this.apiKey && this.index.some(e => e.embedding)) {
			try {
				qEmb  = await this.getEmbedding(query);
				qNorm = vectorNorm(qEmb);
			} catch (e) {
				console.warn("[GPT RAG] query embedding failed:", (e as Error)?.message);
			}
		}

		// Compute both scores for each chunk
		const scored = this.index.map(e => {
			this.ensureEntryCache(e);
			const bm  = useLexical ? bm25Score(qt, e._tf ?? {}, e.tokens.length, avgLen) : 0;
			const cos = (useEmbedding && qEmb && e.embedding)
				? cosineSim(qEmb, e.embedding, qNorm, e._embNorm ?? undefined)
				: 0;
			return { entry: e, bm, cos };
		});

		// Reciprocal Rank Fusion — independent of result scale
		const K = 60;
		const rankBM  = [...scored].sort((a, b) => b.bm  - a.bm)
			.map((s, i) => [s.entry.path + s.entry.chunk, i] as const);
		const rankCos = [...scored].sort((a, b) => b.cos - a.cos)
			.map((s, i) => [s.entry.path + s.entry.chunk, i] as const);

		const rrfMap = new Map<string, number>();
		for (const [id, rank] of rankBM)  rrfMap.set(id, (rrfMap.get(id) ?? 0) + 1 / (K + rank));
		for (const [id, rank] of rankCos) rrfMap.set(id, (rrfMap.get(id) ?? 0) + 1 / (K + rank));

		// Bonus for matching the note title
		const byFile: Record<string, RAGSearchResult> = {};
		for (const s of scored) {
			const id  = s.entry.path + s.entry.chunk;
			let score = rrfMap.get(id) ?? 0;

			// Title boost — a note whose name matches the query ranks higher
			const titleTokens  = tokenize(s.entry.basename);
			const titleMatches = qt.filter(q => titleTokens.includes(q)).length;
			if (titleMatches > 0) score += 0.15 * (titleMatches / qt.length);

			if (mode === "recent" && s.entry.mtime) {
				const ageDays = Math.max(0, (Date.now() - s.entry.mtime) / 86_400_000);
				score += Math.max(0, 0.2 - Math.min(0.2, ageDays / 365));
			}

			if (!byFile[s.entry.path] || score > byFile[s.entry.path].score) {
				byFile[s.entry.path] = {
					path:     s.entry.path,
					basename: s.entry.basename,
					chunk:    s.entry.chunk,
					score,
				};
			}
		}

		return Object.values(byFile)
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
	}

	// ── Incremental updates ────────────────────────────────────────────────────

	async updateFile(file: TFile): Promise<void> {
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

			const chunks     = chunkText(content);
			const newEntries: RAGEntry[] = chunks.map(chunk => {
				const tokens = tokenize(chunk);
				return {
					path:      file.path,
					basename:  file.basename,
					extension: file.extension,
					folder: file.parent?.path ?? "",
					mtime: file.stat?.mtime ?? Date.now(),
					chunk,
					tokens,
					embedding: null,
					_tf:       buildTermFreq(tokens),
				};
			});

			// Batch embeddings (instead of sequential requests)
			if (this.apiKey && newEntries.length) {
				try {
					const embeddings = await this.getEmbeddingsBatch(newEntries.map(e => e.chunk));
					for (let i = 0; i < embeddings.length; i++) {
						newEntries[i].embedding = embeddings[i];
						newEntries[i]._embNorm  = vectorNorm(embeddings[i]);
					}
				} catch (e) {
					console.warn("[GPT RAG] updateFile embedding failed:", (e as Error)?.message);
				}
			}

			this.index.push(...newEntries);
			this.recalcAvgLen();
			this.scheduleSave();
		} catch (e) {
			console.warn("[GPT RAG] updateFile error:", file?.path, (e as Error)?.message);
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
		let changed = false;

		for (const e of this.index) {
			if (e.path === oldPath) {
				e.path     = newPath;
				e.basename = basename;
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

	// ── Helpers ────────────────────────────────────────────────────────────────

	private recalcAvgLen(): void {
		this.cachedAvgLen = this.index.length
			? this.index.reduce((s, e) => s + e.tokens.length, 0) / this.index.length
			: 0;
	}

	/** Ensures the entry has cache populated: TF + embeddingNorm */
	private ensureEntryCache(entry: RAGEntry): void {
		if (!entry._tf) entry._tf = buildTermFreq(entry.tokens);
		if (entry.embedding && entry._embNorm == null) {
			entry._embNorm = vectorNorm(entry.embedding);
		}
	}
}
