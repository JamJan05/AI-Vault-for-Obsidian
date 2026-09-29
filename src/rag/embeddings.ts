/**
 * Embeddings policy and wire format.
 *
 * Creating an embedding means sending note text — or the user's question — to
 * OpenAI. That is the largest data flow in the plugin, so the decision whether it
 * may happen lives here, in one dependency-free function that is unit tested.
 */

export const EMBEDDINGS_URL   = "https://api.openai.com/v1/embeddings";
export const EMBEDDINGS_MODEL = "text-embedding-3-small";

/** Longest text sent for a single embedding; longer chunks are truncated. */
export const EMBEDDING_MAX_CHARS = 8000;

export interface EmbeddingsSettings {
	ragEnabled?:           boolean;
	ragEmbeddingsEnabled?: boolean;
	apiKey?:               string;
}

/**
 * True only when the user has switched semantic search on, RAG itself is on, and
 * there is a key to send. An OpenAI key alone is never enough: someone who uses
 * Claude or a local model may still have one saved.
 */
export function canUseEmbeddings(settings: EmbeddingsSettings): boolean {
	return settings.ragEmbeddingsEnabled === true
		&& settings.ragEnabled !== false
		&& typeof settings.apiKey === "string"
		&& settings.apiKey.trim().length > 0;
}

export function buildEmbeddingsBody(texts: string[]): { model: string; input: string[] } {
	return {
		model: EMBEDDINGS_MODEL,
		input: texts.map(text => text.slice(0, EMBEDDING_MAX_CHARS)),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isVector(value: unknown): value is number[] {
	return Array.isArray(value)
		&& value.length > 0
		&& value.every(n => typeof n === "number" && Number.isFinite(n));
}

/**
 * Validates an embeddings response and returns the vectors in input order.
 * Throws on anything unexpected, so a malformed response can never be stored as
 * a vector or silently shift vectors onto the wrong chunks.
 */
export function parseEmbeddingsResponse(json: unknown, expectedCount: number): number[][] {
	if (!isRecord(json) || !Array.isArray(json.data)) {
		throw new Error("Invalid embeddings response. Expected data[].embedding.");
	}
	if (json.data.length !== expectedCount) {
		throw new Error(`Invalid embeddings response. Expected ${expectedCount} vectors, got ${json.data.length}.`);
	}

	const vectors = new Array<number[] | undefined>(expectedCount).fill(undefined);
	json.data.forEach((item: unknown, position: number) => {
		if (!isRecord(item) || !isVector(item.embedding)) {
			throw new Error("Invalid embeddings response. An embedding is missing or not numeric.");
		}
		// The API returns an index per item; fall back to the position when it is absent.
		const index = typeof item.index === "number" ? item.index : position;
		if (!Number.isInteger(index) || index < 0 || index >= expectedCount || vectors[index]) {
			throw new Error("Invalid embeddings response. Embedding indexes are inconsistent.");
		}
		vectors[index] = item.embedding;
	});

	return vectors as number[][];
}
