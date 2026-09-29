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

/**
 * Debounce with one timer per key. A call for one key never cancels a pending
 * call for another — with a single shared timer, editing note B within the delay
 * would silently drop the update for note A.
 */
export interface KeyedDebounce<T> {
	(key: string, value: T): void;
	/** Cancels every pending call. */
	cancel(): void;
	/** Number of calls still waiting. */
	readonly pending: number;
}

export function createKeyedDebounce<T>(
	fn: (key: string, value: T) => void,
	delay: number,
): KeyedDebounce<T> {
	const timers = new Map<string, number>();

	const debounced = (key: string, value: T): void => {
		const existing = timers.get(key);
		if (existing !== undefined) window.clearTimeout(existing);
		timers.set(key, window.setTimeout(() => {
			timers.delete(key);
			fn(key, value);
		}, delay));
	};

	debounced.cancel = (): void => {
		for (const timer of timers.values()) window.clearTimeout(timer);
		timers.clear();
	};

	Object.defineProperty(debounced, "pending", { get: () => timers.size });
	return debounced as KeyedDebounce<T>;
}

// ─── Identifiers ──────────────────────────────────────────────────────────────

/**
 * Unique id for a session or a project. Only letters, digits and dashes, so it is
 * safe inside a file name. A timestamp alone collides when two are made in the
 * same millisecond, and two conversations would then share one file.
 */
export function newId(): string {
	const cryptoApi = window.crypto;
	if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();

	// Older runtimes: the same random source, spelled out as eight base-36 characters.
	const bytes  = cryptoApi.getRandomValues(new Uint8Array(8));
	const random = Array.from(bytes, byte => (byte % 36).toString(36)).join("");
	return `${Date.now().toString(36)}-${random}`;
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

// ─── Formatting ───────────────────────────────────────────────────────────────

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

// ─── Chunking ─────────────────────────────────────────────────────────────────

/** A fragment shorter than this says too little on its own and is joined to its neighbour. */
const MIN_CHUNK_CHARS = 200;

/** Cuts text that has no paragraph breaks into pieces of at most `size`, at a space where possible. */
function splitOversized(text: string, size: number): string[] {
	const pieces: string[] = [];
	let rest = text.trim();

	while (rest.length > size) {
		let cut = Math.max(rest.lastIndexOf("\n", size), rest.lastIndexOf(" ", size));
		if (cut < size / 2) cut = size;
		pieces.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) pieces.push(rest);
	return pieces;
}

/** Splits one section by paragraphs, carrying a short tail over for context. */
function splitSection(section: string, size: number, overlap: number): string[] {
	const chunks: string[] = [];
	const paragraphs = section.split(/\n{2,}/).flatMap(p => p.length > size ? splitOversized(p, size) : [p]);
	let cur = "";

	for (const p of paragraphs) {
		if (cur.length + p.length > size && cur.length > 0) {
			chunks.push(cur.trim());
			const tail = cur.length > overlap ? cur.slice(-overlap) : "";
			cur = tail + (tail ? "\n\n" : "") + p;
		} else {
			cur += (cur ? "\n\n" : "") + p;
		}
	}

	if (cur.trim()) chunks.push(cur.trim());
	return chunks;
}

/**
 * Splits text into chunks — first by H1/H2 headings, then by paragraphs with
 * overlap. A fragment that is too short to mean anything, such as a heading
 * without its text, is joined to the fragment that follows it.
 */
export function chunkText(
	text:    string,
	size    = RAG_CHUNK_SIZE,
	overlap = RAG_CHUNK_OVERLAP,
): string[] {
	// Split on H1/H2 headings — natural section boundaries
	const pieces = text
		.split(/(?=^#{1,2}\s)/m)
		.map(section => section.trim())
		.filter(section => section.length > 0)
		.flatMap(section => section.length <= size ? [section] : splitSection(section, size, overlap));

	const minChars = Math.min(MIN_CHUNK_CHARS, Math.floor(size / 3));
	const chunks: string[] = [];
	let carry = "";

	for (const piece of pieces) {
		const candidate = carry ? `${carry}\n\n${piece}` : piece;
		if (candidate.length < minChars) {
			carry = candidate;
		} else {
			chunks.push(candidate);
			carry = "";
		}
	}

	// A short ending belongs to what came before it.
	if (carry) {
		const last = chunks.length - 1;
		if (last >= 0 && chunks[last].length + carry.length <= size * 1.5) {
			chunks[last] = `${chunks[last]}\n\n${carry}`;
		} else {
			chunks.push(carry);
		}
	}

	return chunks.length ? chunks : [text.slice(0, size)];
}
