/**
 * Validation of note paths that come from a model.
 *
 * A tool call names the note it wants to read or change. That name is untrusted,
 * so it is checked here before it reaches the vault: only Markdown notes inside
 * the vault, never hidden folders and never Obsidian's configuration folder.
 *
 * Pure string logic, no Obsidian imports, so it is unit tested as written.
 */

const MAX_PATH_CHARS = 1024;
/** Characters Obsidian does not allow in a file name. */
const FORBIDDEN_CHARS = /[*"<>:|?]/;

export type NoteExtension = ".md" | ".canvas";

export type NotePathResult =
	| { ok: true;  path: string }
	| { ok: false; reason: string };

function refuse(reason: string): NotePathResult {
	return { ok: false, reason };
}

/**
 * Turns a path given by a model into a vault-relative path of a Markdown note,
 * or of a canvas when `extension` says so.
 * @param configDir Obsidian's configuration folder (`vault.configDir`)
 */
export function resolveNotePath(raw: unknown, configDir: string, extension: NoteExtension = ".md"): NotePathResult {
	if (typeof raw !== "string") return refuse("The path must be a string.");

	const trimmed = raw.trim();
	if (!trimmed) return refuse("The path is empty.");
	if (trimmed.length > MAX_PATH_CHARS) return refuse("The path is too long.");
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed.charCodeAt(i) < 32) return refuse("The path contains control characters.");
	}
	if (trimmed.includes("\\")) return refuse("Use forward slashes in the path.");
	if (trimmed.startsWith("/")) return refuse("Use a path relative to the vault root, without a leading slash.");
	if (FORBIDDEN_CHARS.test(trimmed)) return refuse("The path contains characters that are not allowed in file names.");

	const segments = trimmed.split("/");
	for (const segment of segments) {
		if (!segment) return refuse("The path contains an empty segment.");
		if (segment === "." || segment === "..") return refuse("The path must not contain . or .. segments.");
		if (segment.startsWith(".")) return refuse("Hidden files and folders cannot be used.");
		if (segment !== segment.trim()) return refuse("A path segment starts or ends with a space.");
	}

	if (!trimmed.toLowerCase().endsWith(extension)) {
		return refuse(extension === ".md"
			? "Only Markdown notes can be used here. The path must end with .md. For a canvas, use read_canvas and edit_canvas."
			: "Only canvases can be used here. The path must end with .canvas. For a note, use the note tools.");
	}
	if (segments[segments.length - 1].length <= extension.length) return refuse("The file has no name.");

	const config = (configDir ?? "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
	if (config) {
		const lower = trimmed.toLowerCase();
		if (lower === config || lower.startsWith(`${config}/`)) {
			return refuse("Obsidian's configuration folder cannot be used.");
		}
	}

	return { ok: true, path: trimmed };
}
