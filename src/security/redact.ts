/**
 * Secret redaction for anything that may end up in an error message, a Notice,
 * the developer console or a CI report.
 *
 * Deliberately dependency-free so the exact same function can be unit tested and
 * reused by the compliance tooling in `scripts/compliance/`.
 *
 * Rules that shaped this module:
 * - Never put a raw response body from an untrusted endpoint into a message.
 * - Never echo an Authorization header, an API key, or anything shaped like one.
 * - Control characters are stripped so a hostile endpoint cannot forge log lines.
 */

export const REDACTED = "[redacted]";

/** Upper bound for any provider-supplied fragment we are willing to surface. */
export const MAX_DETAIL_LENGTH = 300;

/**
 * Order matters: the more specific header/JSON forms run first so that the
 * generic key-shape patterns cannot claim part of the match and leave the
 * surrounding label behind.
 */
const PATTERNS: Array<[RegExp, string]> = [
	// Authorization: Bearer <token>  /  "Authorization": "Bearer <token>"
	[/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
	// Authorization / x-api-key / api-key in header form (`Name: value`) and in
	// JSON form (`"Name":"value"`) — the optional quote after the name is what
	// makes the JSON form match.
	[/\b(authorization|x-api-key|api[-_]?key)("?\s*[:=]\s*)"[^"]*"/gi, `$1$2"${REDACTED}"`],
	[/\b(authorization|x-api-key|api[-_]?key)("?\s*[:=]\s*)'[^']*'/gi, `$1$2'${REDACTED}'`],
	[/\b(authorization|x-api-key|api[-_]?key)("?\s*[:=]\s*)[^\s,;}"']+/gi, `$1$2${REDACTED}`],
	// Settings field names used by this plugin, in JSON or query-string form
	[/\b(apiKey|claudeApiKey|localApiKey)("?\s*[:=]\s*)"[^"]*"/gi, `$1$2"${REDACTED}"`],
	[/\b(apiKey|claudeApiKey|localApiKey)("?\s*[:=]\s*)'[^']*'/gi, `$1$2'${REDACTED}'`],
	[/\b(apiKey|claudeApiKey|localApiKey)("?\s*[:=]\s*)[^\s,;}"']+/gi, `$1$2${REDACTED}`],
	// Anthropic key shape — must precede the OpenAI shape, which is a prefix of it
	[/\bsk-ant-[A-Za-z0-9_-]{6,}/g, REDACTED],
	// OpenAI key shapes (sk-, sk-proj-, sk-svcacct-, …)
	[/\bsk-(?:[A-Za-z]+-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
	// Credentials embedded in a URL: scheme://user:pass@host
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
];

/** Replaces every known secret shape in `input`. Safe to call on any string. */
export function redactSecrets(input: string): string {
	if (typeof input !== "string" || !input) return "";

	let out = input;
	for (const [pattern, replacement] of PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/**
 * Removes C0/C1 control characters (except that tabs and newlines collapse to a
 * space) so a remote value cannot inject ANSI escapes or fake log lines.
 */
export function stripControlCharacters(input: string): string {
	if (typeof input !== "string" || !input) return "";

	let out = "";
	for (const char of input.replace(/[\t\n\r]+/g, " ")) {
		const code = char.codePointAt(0) ?? 0;
		const isC0 = code < 0x20;
		const isDelete = code === 0x7f;
		const isC1 = code >= 0x80 && code <= 0x9f;
		if (isC0 || isDelete || isC1) continue;
		out += char;
	}
	return out;
}

/**
 * Turns an arbitrary value from an untrusted source into a short, secret-free,
 * single-line fragment that is safe to show to the user or write to a report.
 *
 * Returns an empty string when nothing usable is left — callers should then fall
 * back to a fixed message rather than showing an empty detail.
 */
export function sanitizeErrorDetail(raw: unknown, maxLength: number = MAX_DETAIL_LENGTH): string {
	if (raw === null || raw === undefined) return "";

	const asText =
		typeof raw === "string" ? raw :
		raw instanceof Error ? raw.message :
		typeof raw === "number" || typeof raw === "boolean" ? String(raw) :
		safeStringify(raw);

	const cleaned = stripControlCharacters(redactSecrets(asText)).replace(/\s{2,}/g, " ").trim();
	if (!cleaned) return "";
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, maxLength)}… (truncated)`;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/**
 * Builds a user-facing error message: a fixed, translatable prefix plus an
 * optional sanitized detail. The prefix is always present, so the user still
 * gets an actionable message when the detail is dropped entirely.
 */
export function safeErrorMessage(prefix: string, raw?: unknown, maxLength: number = MAX_DETAIL_LENGTH): string {
	const detail = sanitizeErrorDetail(raw, maxLength);
	return detail ? `${prefix} ${detail}` : prefix;
}
