/**
 * Shared context for compliance checks: repository paths, parsed policy files,
 * a cached source-file index, and the project's own redaction function.
 *
 * The redaction function is deliberately NOT re-implemented here. It is compiled
 * from `src/security/redact.ts` — the same module the unit tests exercise — so a
 * report can never be redacted by a second, untested copy of the rules.
 */

import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Loads and compiles src/security/redact.ts so the report uses the tested rules. */
async function loadRedaction() {
	const outDir = await mkdtemp(join(tmpdir(), "ai-vault-redact-"));
	const outfile = join(outDir, "redact.mjs");
	try {
		await build({
			entryPoints: [join(ROOT, "src", "security", "redact.ts")],
			outfile,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node20",
			logLevel: "silent",
		});
		const mod = await import(pathToFileURL(outfile).href);
		if (typeof mod.sanitizeErrorDetail !== "function" || typeof mod.redactSecrets !== "function") {
			throw new Error("redact.ts did not export the expected functions");
		}
		return { redactSecrets: mod.redactSecrets, sanitizeErrorDetail: mod.sanitizeErrorDetail };
	} finally {
		// The compiled module is already in memory; the temp directory is not needed.
		await rm(outDir, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Removes line and block comment content from a single line.
 * Not a parser — good enough to keep prose out of behavioural checks.
 */
export function stripComments(line) {
	return line
		.replace(/^\s*(?:\/\/|\/\*+|\*+\/?)\s?.*$/, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/([^:"'`])\/\/.*$/, "$1");
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function readTextIfExists(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

/** Recursively lists files under `dir`, skipping the directories in `skip`. */
async function walk(dir, skip = new Set(["node_modules", ".git", ".testbuild", "dist"])) {
	const out = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (skip.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full, skip)));
		else out.push(full);
	}
	return out;
}

/** git output, or null when git is unavailable or the command fails. */
async function git(args) {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
		return stdout;
	} catch {
		return null;
	}
}

export async function createContext() {
	const [redaction, obsidianPolicy, projectPolicy] = await Promise.all([
		loadRedaction(),
		readJson(join(ROOT, ".compliance", "obsidian-policy-map.json")),
		readJson(join(ROOT, ".compliance", "ai-vault-policy.json")),
	]);

	const manifest = await readJson(join(ROOT, "manifest.json"));
	const pkg = await readJson(join(ROOT, "package.json"));
	const versions = existsSync(join(ROOT, "versions.json"))
		? await readJson(join(ROOT, "versions.json"))
		: null;
	const lock = existsSync(join(ROOT, "package-lock.json"))
		? await readJson(join(ROOT, "package-lock.json"))
		: null;

	const srcFiles = (await walk(join(ROOT, "src")))
		.filter(p => p.endsWith(".ts"))
		.sort();

	/** @type {Map<string, {path: string, rel: string, text: string, lines: string[]}>} */
	const sources = new Map();
	for (const path of srcFiles) {
		const text = await readFile(path, "utf8");
		sources.set(path, {
			path,
			rel: relative(ROOT, path).split(sep).join("/"),
			text,
			lines: text.split("\n"),
		});
	}

	const workflowDir = join(ROOT, ".github", "workflows");
	const workflows = new Map();
	for (const path of (await walk(workflowDir)).filter(p => /\.ya?ml$/.test(p))) {
		workflows.set(path, {
			path,
			rel: relative(ROOT, path).split(sep).join("/"),
			text: await readFile(path, "utf8"),
		});
	}

	const docs = {
		readme: await readTextIfExists(join(ROOT, "README.md")),
		privacy: await readTextIfExists(join(ROOT, "PRIVACY.md")),
		security: await readTextIfExists(join(ROOT, "SECURITY.md")),
		checks: await readTextIfExists(join(ROOT, "docs", "SECURITY-PRIVACY-CHECKS.md")),
		license: await readTextIfExists(join(ROOT, "LICENSE")),
		gitignore: (await readTextIfExists(join(ROOT, ".gitignore"))) ?? "",
	};

	const bundlePath = join(ROOT, "main.js");
	const bundle = await readTextIfExists(bundlePath);

	// Two different questions, two different lists.
	// `trackedFiles` answers "is this committed?" — used by the lockfile and
	// committed-binary checks, where an untracked file is simply not the subject.
	const trackedFiles = (await git(["ls-files"]))?.split("\n").filter(Boolean) ?? null;
	// `scannableFiles` answers "what could leak?" — tracked plus present but
	// not yet committed, minus anything git-ignored. A secret scanner that only
	// looks at committed files reports clean right up until the commit that leaks
	// the key.
	const untracked = (await git(["ls-files", "--others", "--exclude-standard"]))?.split("\n").filter(Boolean) ?? [];
	const scannableFiles = trackedFiles === null ? null : [...new Set([...trackedFiles, ...untracked])].sort();
	const tags = (await git(["tag", "-l"]))?.split("\n").map(s => s.trim()).filter(Boolean) ?? null;

	return {
		root: ROOT,
		redaction,
		obsidianPolicy,
		projectPolicy,
		manifest,
		pkg,
		versions,
		lock,
		sources,
		workflows,
		docs,
		bundle,
		bundlePath,
		trackedFiles,
		scannableFiles,
		tags,
		rule(id) {
			return this.obsidianPolicy.rules.find(r => r.id === id) ?? null;
		},
		/** Convenience: rule metadata attached to a result. */
		ruleMeta(id) {
			const rule = this.rule(id);
			return rule ? { rule: rule.id, source: rule.source } : {};
		},
		/**
		 * Every source line matching `pattern`, as findings-friendly records.
		 *
		 * `skipComments` removes line and block comments before matching. Use it for
		 * checks about what the code *does* — a comment that names `fetch()` or an
		 * example IP is documentation, not behaviour.
		 */
		grepSources(pattern, { exclude = [], skipComments = false, skipFile } = {}) {
			const hits = [];
			for (const file of this.sources.values()) {
				if (exclude.some(fragment => file.rel.includes(fragment))) continue;
				if (skipFile && skipFile(file)) continue;
				file.lines.forEach((line, index) => {
					const subject = skipComments ? stripComments(line) : line;
					if (!subject.trim()) return;
					pattern.lastIndex = 0;
					if (pattern.test(subject)) {
						hits.push({ file: file.rel, line: index + 1, evidence: line.trim() });
					}
				});
			}
			return hits;
		},
		/** True when a live exception covers `target` for `appliesTo`. */
		activeException(appliesTo, targetFragment, now = new Date()) {
			return (this.projectPolicy.exceptions ?? []).find(exception => {
				if (exception.appliesTo !== appliesTo) return false;
				if (!String(exception.target).includes(targetFragment) && !targetFragment.includes(String(exception.target))) return false;
				if (exception.expiresOn && new Date(exception.expiresOn) < now) return false;
				return exception.decision === "accepted";
			}) ?? null;
		},
	};
}
