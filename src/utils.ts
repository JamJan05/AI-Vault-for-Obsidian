import { RAG_CHUNK_OVERLAP, RAG_CHUNK_SIZE } from "./constants";

// ─── Async helpers ────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
	return new Promise(r => window.setTimeout(r, ms));
}

// ─── Debounce ─────────────────────────────────────────────────────────────────

interface DebouncedFn<T extends unknown[]> {
	(...args: T): void;
	cancel(): void;
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void, delay: number): DebouncedFn<T> {
	let timer: number | null = null;

	const debounced = (...args: T): void => {
		if (timer) window.clearTimeout(timer);
		timer = window.setTimeout(() => { timer = null; fn(...args); }, delay);
	};

	debounced.cancel = (): void => {
		if (timer) { window.clearTimeout(timer); timer = null; }
	};

	return debounced;
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

interface RetryOptions {
	maxRetries?: number;
	baseDelay?:  number;
	maxDelay?:   number;
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	{ maxRetries = 3, baseDelay = 1000, maxDelay = 30000 }: RetryOptions = {},
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			const e = err as { name?: string; noRetry?: boolean } | null;
			// Do not retry user-initiated aborts, nor errors flagged as non-retryable
			// (e.g. streaming errors after partial chunks were already delivered to the UI).
			if (e?.name === "AbortError") throw err;
			if (e?.noRetry) throw err;
			if (attempt === maxRetries) break;

			const jitter = Math.random() * 200;
			const delay  = Math.min(baseDelay * 2 ** attempt + jitter, maxDelay);
			await sleep(delay);
		}
	}

	throw lastError;
}

// ─── String / HTML helpers ────────────────────────────────────────────────────

/** Escape HTML before composing markup strings. */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/** Sanitizes a URL — allows only http(s) and mailto, blocks javascript:/data: */
export function sanitizeUrl(url: string): string {
	if (typeof url !== "string") return "#";
	const trimmed = url.trim();
	if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[/.#]/.test(trimmed)) return trimmed;
	return "#";
}

/** UTF-8 safe base64 encode */
export function utf8ToBase64(str: string): string {
	return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_match: string, p1: string) =>
		String.fromCharCode(parseInt(p1, 16)),
	));
}

/** UTF-8 safe base64 decode */
export function base64ToUtf8(b64: string): string {
	return decodeURIComponent(
		atob(b64).split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""),
	);
}

/** Formats a timestamp as a locale date and time */
export function formatDate(ts: number): string {
	const d = new Date(ts);
	return (
		d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }) +
		" " +
		d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
	);
}

// ─── RAG: text helpers ────────────────────────────────────────────────────────

/** FNV-1a 32-bit hash — fast, collisions are negligible for file change detection */
export function contentHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(16);
}

// ─── Stopwords (Polish + English) ────────────────────────────────────────────

const STOPWORDS = new Set<string>([
	// Polish
	"ale","albo","aby","bez","być","było","była","były","czy","dla","gdy","gdzie",
	"ich","jak","jako","jest","jego","jej","już","kiedy","która","które","który",
	"lub","może","nad","nie","oraz","poza","przez","przy","tak","tam","tej","ten",
	"tego","tym","tu","tylko","wam","wasz","więc","wszystko","wy","ze","że","żeby",
	"się","pan","pani","tego","temu","tych","tym","tymi","nas","nam","was","ją",
	// English
	"the","and","for","are","but","not","you","all","can","her","was","one","our",
	"had","have","has","with","this","that","they","from","were","been","will","its",
	"been","than","into","more","also","over","such","when","than","then","some",
]);

/**
 * Tokenizes text with Unicode support (preserves accented characters e.g. ą,ć,ę,ł,ń,ó,ś,ź,ż).
 * Removes stopwords and tokens shorter than 3 characters.
 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/** Builds a term-frequency map for a document (cached on the entry) */
export function buildTermFreq(tokens: string[]): Record<string, number> {
	const tf: Record<string, number> = {};
	for (const token of tokens) tf[token] = (tf[token] || 0) + 1;
	return tf;
}

// ─── RAG: math ────────────────────────────────────────────────────────────────

export function dotProduct(a: number[], b: number[]): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}

export function vectorNorm(v: number[]): number {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i] * v[i];
	return Math.sqrt(s);
}

/** Cosine similarity with optional pre-computed norms */
export function cosineSim(a: number[], b: number[], normA?: number, normB?: number): number {
	const na = normA ?? vectorNorm(a);
	const nb = normB ?? vectorNorm(b);
	if (!na || !nb) return 0;
	return dotProduct(a, b) / (na * nb);
}

export function bm25Score(
	qTokens:  string[],
	docTf:    Record<string, number>,
	docLen:   number,
	avgLen:   number,
	k1 = 1.5,
	b  = 0.75,
): number {
	let score = 0;
	const lenNorm = 1 - b + b * docLen / Math.max(avgLen, 1);
	for (const token of qTokens) {
		const tf = docTf[token];
		if (!tf) continue;
		score += (tf * (k1 + 1)) / (tf + k1 * lenNorm);
	}
	return score;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Splits text into chunks — first by H1/H2 headings,
 * then by paragraphs with overlap, preserving context across fragments.
 */
export function chunkText(
	text:    string,
	size    = RAG_CHUNK_SIZE,
	overlap = RAG_CHUNK_OVERLAP,
): string[] {
	// Split on H1/H2 headings — natural section boundaries
	const sections = text.split(/(?=^#{1,2}\s)/m);
	const chunks: string[] = [];

	for (const section of sections) {
		if (section.length <= size) {
			if (section.trim()) chunks.push(section.trim());
			continue;
		}

		// Large sections: split by paragraphs with overlap
		const paras = section.split(/\n{2,}/);
		let cur = "";

		for (const p of paras) {
			if (cur.length + p.length > size && cur.length > 0) {
				chunks.push(cur.trim());
				const tail = cur.length > overlap ? cur.slice(-overlap) : "";
				cur = tail + (tail ? "\n\n" : "") + p;
			} else {
				cur += (cur ? "\n\n" : "") + p;
			}
		}

		if (cur.trim()) chunks.push(cur.trim());
	}

	return chunks.length ? chunks : [text.slice(0, size)];
}
