/**
 * Central policy for the user-configurable Local API Base URL.
 *
 * The Base URL decides where chat messages, note excerpts, RAG chunks and the
 * Local API key are sent, so it is the single most sensitive setting in the
 * plugin. Everything here is parsed with the WHATWG `URL` parser — never with a
 * bare regex — because host confusion is exactly the class of bug a regex misses.
 *
 * Dependency-free on purpose: the same rules are unit tested and re-used by the
 * compliance tooling in `scripts/compliance/`.
 */

export type BaseUrlVerdict =
	/** Plain HTTP to a real loopback address — expected for LM Studio/Ollama. */
	| "loopback-http"
	/** Loopback over TLS. */
	| "loopback-https"
	/** Remote host over TLS. */
	| "remote-https"
	/** Remote host over plain HTTP — allowed, but only with an explicit warning. */
	| "remote-http"
	/** Empty, unparseable, or a scheme that must never be used for API calls. */
	| "invalid";

export interface BaseUrlAssessment {
	/** False only for `invalid` — a remote HTTP endpoint is usable but must warn. */
	readonly usable: boolean;
	readonly verdict: BaseUrlVerdict;
	/** True when the user must see a warning before data is sent. */
	readonly requiresWarning: boolean;
	/** Machine-readable reason code; `null` when nothing is wrong. */
	readonly reason: BaseUrlReason | null;
	readonly protocol: string | null;
	/** Hostname with IPv6 brackets removed, lowercased. */
	readonly hostname: string | null;
	readonly isLoopback: boolean;
	readonly isPlainHttp: boolean;
	/** True when the URL embeds `user:password@` — those leak into logs and history. */
	readonly hasEmbeddedCredentials: boolean;
}

export type BaseUrlReason =
	| "empty"
	| "unparseable"
	| "forbidden-scheme"
	| "missing-host"
	| "remote-plaintext"
	| "embedded-credentials";

/** Only these two schemes can ever carry an API request. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Schemes that are explicitly called out as forbidden. Anything not in
 * ALLOWED_PROTOCOLS is rejected anyway; this list exists so the reason code and
 * the tests name the dangerous cases directly.
 */
export const FORBIDDEN_PROTOCOLS = Object.freeze([
	"file:", "javascript:", "data:", "ftp:", "blob:", "ws:", "wss:", "chrome:", "app:",
]);

/** Matches an IPv4 dotted quad. Used only after `URL` has accepted the host. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Strips the brackets the URL parser keeps around an IPv6 literal. */
function unbracket(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]")
		? hostname.slice(1, -1)
		: hostname;
}

/**
 * True only for a genuine loopback address.
 *
 * Deliberately strict:
 * - `localhost` matches exactly (a trailing root dot is tolerated).
 * - `evil-localhost.com`, `localhost.example.com` and `notlocalhost` do NOT match,
 *   which is the host-confusion trick a substring check would fall for.
 * - `sub.localhost` does not match either. RFC 6761 reserves it for loopback, but
 *   resolution is resolver-dependent, so treating it as remote is the safe default.
 * - The whole 127.0.0.0/8 range matches, not just 127.0.0.1.
 * - IPv6 `::1` matches, including the `[::1]` bracketed form and `::ffff:127.x.x.x`
 *   IPv4-mapped addresses.
 */
export function isLoopbackHostname(hostname: string): boolean {
	if (typeof hostname !== "string") return false;

	const host = unbracket(hostname.trim().toLowerCase()).replace(/\.$/, "");
	if (!host) return false;

	if (host === "localhost") return true;

	const ipv4 = IPV4.exec(host);
	if (ipv4) {
		const octets = ipv4.slice(1).map(Number);
		if (octets.some(o => o > 255)) return false;
		return octets[0] === 127;
	}

	if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;

	// IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
	const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
	if (mapped) return isLoopbackHostname(mapped[1]);

	return false;
}

/**
 * Classifies a Base URL. Never throws.
 *
 * A private LAN server (e.g. `http://192.168.1.10:11434`) is deliberately NOT
 * blocked — some users run Ollama on another machine on purpose — but it is
 * classified as `remote-http` so the UI warns before anything is sent.
 */
export function assessLocalBaseUrl(raw: string): BaseUrlAssessment {
	const value = (raw ?? "").trim();
	if (!value) return fail("empty", null, null);

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return fail("unparseable", null, null);
	}

	const protocol = parsed.protocol.toLowerCase();
	if (!ALLOWED_PROTOCOLS.has(protocol)) {
		return fail("forbidden-scheme", protocol, null);
	}

	const hostname = unbracket(parsed.hostname).toLowerCase();
	if (!hostname) return fail("missing-host", protocol, null);

	const isLoopback = isLoopbackHostname(parsed.hostname);
	const isPlainHttp = protocol === "http:";
	const hasEmbeddedCredentials = parsed.username !== "" || parsed.password !== "";

	const verdict: BaseUrlVerdict =
		isLoopback ? (isPlainHttp ? "loopback-http" : "loopback-https") :
		isPlainHttp ? "remote-http" : "remote-https";

	// A remote plaintext endpoint is the headline risk; embedded credentials are
	// reported when nothing more severe applies.
	const reason: BaseUrlReason | null =
		verdict === "remote-http" ? "remote-plaintext" :
		hasEmbeddedCredentials ? "embedded-credentials" :
		null;

	return {
		usable: true,
		verdict,
		requiresWarning: verdict === "remote-http" || hasEmbeddedCredentials,
		reason,
		protocol,
		hostname,
		isLoopback,
		isPlainHttp,
		hasEmbeddedCredentials,
	};
}

function fail(reason: BaseUrlReason, protocol: string | null, hostname: string | null): BaseUrlAssessment {
	return {
		usable: false,
		verdict: "invalid",
		requiresWarning: true,
		reason,
		protocol,
		hostname,
		isLoopback: false,
		isPlainHttp: false,
		hasEmbeddedCredentials: false,
	};
}
