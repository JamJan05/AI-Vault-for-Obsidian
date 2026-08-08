/**
 * Path containment helpers for the optional storage directory outside the vault.
 *
 * `ExternalStorage` builds every file path by joining user-influenced parts onto
 * a base directory. These helpers make sure the result cannot escape that base,
 * even when a part contains `..`, an absolute path, a Windows drive letter, or a
 * NUL byte.
 *
 * Pure string logic, no Node imports, so it can be unit tested directly.
 */

/** Characters that must never appear in a path segment we construct. */
const NUL = "\u0000";

/** Normalizes separators and collapses duplicates. Does not resolve `..`. */
export function toPosixPath(value: string): string {
	return (value ?? "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/**
 * True when a single path part is unsafe to append to a trusted base directory.
 *
 * Rejects: empty parts, `.`/`..` traversal at any position, absolute POSIX paths,
 * UNC paths, Windows drive letters and NUL bytes.
 */
export function isUnsafePathSegment(segment: string): boolean {
	if (typeof segment !== "string" || segment.length === 0) return true;
	if (segment.includes(NUL)) return true;

	const posix = toPosixPath(segment);

	// Absolute or UNC
	if (posix.startsWith("/")) return true;
	// Windows drive letter, e.g. "C:" or "C:/x"
	if (/^[a-z]:/i.test(posix)) return true;

	for (const part of posix.split("/")) {
		if (part === "..") return true;
		if (part === ".") return true;
	}

	return false;
}

/**
 * Resolves `..`/`.` inside an already-joined path without touching the file
 * system. Leading `..` parts that would climb above the root are kept, so the
 * caller can still detect the escape via {@link isPathInside}.
 */
export function normalizeResolved(value: string): string {
	const posix = toPosixPath(value);
	const isAbsolute = posix.startsWith("/");
	const driveMatch = /^([a-z]:)/i.exec(posix);
	const drive = driveMatch ? driveMatch[1].toLowerCase() : "";
	const body = drive ? posix.slice(drive.length) : posix;

	const out: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (out.length && out[out.length - 1] !== "..") out.pop();
			else if (!isAbsolute && !drive) out.push("..");
			continue;
		}
		out.push(part);
	}

	const joined = out.join("/");
	if (drive) return `${drive}/${joined}`;
	return isAbsolute ? `/${joined}` : joined;
}

/**
 * True when `candidate` resolves to `base` itself or to something underneath it.
 *
 * Comparison is done on normalized POSIX-style paths. On Windows the drive letter
 * and path are compared case-insensitively, which matches how the file system
 * behaves there; on POSIX the comparison stays case-sensitive.
 */
export function isPathInside(base: string, candidate: string, caseInsensitive = isWindowsStylePath(base)): boolean {
	const normalizedBase = stripTrailingSlash(normalizeResolved(base));
	const normalizedCandidate = stripTrailingSlash(normalizeResolved(candidate));

	if (!normalizedBase) return false;

	const a = caseInsensitive ? normalizedBase.toLowerCase() : normalizedBase;
	const b = caseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate;

	if (a === b) return true;
	return b.startsWith(`${a}/`);
}

function stripTrailingSlash(value: string): string {
	return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function isWindowsStylePath(value: string): boolean {
	return /^[a-z]:/i.test(toPosixPath(value ?? ""));
}

/**
 * Joins `parts` onto `base` and returns the result only when every part is safe
 * and the result stays inside `base`. Returns `null` otherwise — callers must
 * treat `null` as "refuse the operation", never as "use the base directory".
 */
export function safeJoinInside(base: string, ...parts: string[]): string | null {
	if (!base) return null;
	if (parts.some(isUnsafePathSegment)) return null;

	const joined = normalizeResolved([toPosixPath(base), ...parts.map(toPosixPath)].join("/"));
	return isPathInside(base, joined) ? joined : null;
}
