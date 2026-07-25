/**
 * Path exclusion rules for RAG.
 *
 * Deliberately dependency-free (no Obsidian, no Node) so the matching logic stays
 * auditable and reusable by the engine, the link resolver and the chat view.
 *
 * Pattern semantics:
 * - one pattern per line; blank lines are skipped and `#` starts a comment
 * - matching is case-insensitive and always against vault-relative paths
 * - a pattern without `/` matches the file name at any depth, and a top-level
 *   folder with that name
 * - a pattern containing `/` is anchored at the vault root
 * - `*` matches within a single path segment, `**` crosses segments
 * - a wildcard-free pattern also covers everything below it, so `Assets` behaves
 *   like `Assets` plus `Assets/**`
 */

// Placeholder code points: wildcards are swapped out before regex escaping, so
// escaping cannot mangle them, then swapped back in as regex fragments.
const TOKEN_GLOBSTAR_SLASH = "\u0000";
const TOKEN_GLOBSTAR       = "\u0001";
const TOKEN_STAR           = "\u0002";

export interface RagIgnoreMatcher {
	/** True when no usable pattern is configured — callers may skip filtering entirely. */
	readonly isEmpty: boolean;
	/** `path` must be vault-relative, e.g. "Assets/sub/note.md". */
	matches(path: string): boolean;
}

interface CompiledPattern {
	/** Tested against the whole vault-relative path. */
	path: RegExp;
	/** Tested against the file name only; absent for anchored patterns containing `/`. */
	name?: RegExp;
}

const EMPTY_MATCHER: RagIgnoreMatcher = {
	isEmpty: true,
	matches: () => false,
};

/** Lowercases, unifies separators and strips leading/trailing slashes. */
function normalize(value: string): string {
	return value
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

function globToRegexSource(glob: string): string {
	const tokenized = glob
		.replace(/\*\*\//g, TOKEN_GLOBSTAR_SLASH)
		.replace(/\*\*/g,   TOKEN_GLOBSTAR)
		.replace(/\*/g,     TOKEN_STAR);

	const escaped = tokenized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	return escaped
		.split(TOKEN_GLOBSTAR_SLASH).join("(?:.*/)?")
		.split(TOKEN_GLOBSTAR).join(".*")
		.split(TOKEN_STAR).join("[^/]*");
}

function compile(pattern: string): CompiledPattern | null {
	try {
		const source = globToRegexSource(pattern);
		// The optional `(?:/.*)?` tail is what makes a folder pattern cover its contents.
		return {
			path: new RegExp(`^${source}(?:/.*)?$`),
			name: pattern.includes("/") ? undefined : new RegExp(`^${source}$`),
		};
	} catch (e) {
		// One bad pattern must never disable RAG. Log the pattern, never note contents.
		console.warn("[AI-Vault] Skipping invalid RAG ignore pattern:", pattern, (e as Error)?.message);
		return null;
	}
}

function build(raw: string): RagIgnoreMatcher {
	const pathRules: RegExp[] = [];
	const nameRules: RegExp[] = [];

	for (const line of (raw ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const pattern = normalize(trimmed);
		if (!pattern) continue;

		const compiled = compile(pattern);
		if (!compiled) continue;

		pathRules.push(compiled.path);
		if (compiled.name) nameRules.push(compiled.name);
	}

	if (!pathRules.length) return EMPTY_MATCHER;

	return {
		isEmpty: false,
		matches(path: string): boolean {
			const normalized = normalize(path);
			if (!normalized) return false;

			for (const rule of pathRules) {
				if (rule.test(normalized)) return true;
			}

			if (nameRules.length) {
				const name = normalized.slice(normalized.lastIndexOf("/") + 1);
				for (const rule of nameRules) {
					if (rule.test(name)) return true;
				}
			}

			return false;
		},
	};
}

// Patterns are compiled once per settings value: callers hit this on every file
// during indexing and on every entry during search, so re-parsing would be costly.
let cache: { raw: string; matcher: RagIgnoreMatcher } | null = null;

/** Compiles the user's ignore list. Repeated calls with the same text are free. */
export function parseRagIgnorePatterns(raw: string): RagIgnoreMatcher {
	const value = raw ?? "";
	if (cache && cache.raw === value) return cache.matcher;

	const matcher = build(value);
	cache = { raw: value, matcher };
	return matcher;
}
