/**
 * Release artefact and manifest verification.
 *
 * Kept separate from the compliance runner so the build job can fail fast on a
 * broken manifest without waiting for the full policy sweep, and so a developer
 * can run just this before tagging.
 *
 * Usage: node scripts/compliance/verify-release-artifacts.mjs
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const errors = [];
const warnings = [];
const notes = [];

async function readJson(relative) {
	try {
		return JSON.parse(await readFile(join(ROOT, relative), "utf8"));
	} catch (error) {
		errors.push(`${relative} could not be read or parsed: ${error?.message ?? error}`);
		return null;
	}
}

async function fileSize(relative) {
	try {
		return (await stat(join(ROOT, relative))).size;
	} catch {
		return null;
	}
}

async function gitTags() {
	try {
		const { stdout } = await execFileAsync("git", ["tag", "-l"], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
		return stdout.split("\n").map(s => s.trim()).filter(Boolean);
	} catch {
		return null;
	}
}

const manifest = await readJson("manifest.json");
const pkg = await readJson("package.json");
const versions = await readJson("versions.json");
const lock = await readJson("package-lock.json");

if (manifest && pkg) {
	const version = manifest.version;

	// ── Manifest shape ────────────────────────────────────────────────────────
	for (const field of ["id", "name", "version", "minAppVersion", "description", "author"]) {
		if (!manifest[field]) errors.push(`manifest.json is missing "${field}"`);
	}
	if (!/^[a-z0-9-]+$/.test(String(manifest.id ?? ""))) {
		errors.push(`manifest.json id "${manifest.id}" should be lowercase letters, digits and hyphens`);
	}
	if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
		errors.push(`manifest.json version "${version}" is not stable semver (x.y.z)`);
	}
	if (!/^\d+\.\d+\.\d+$/.test(String(manifest.minAppVersion ?? ""))) {
		errors.push(`manifest.json minAppVersion "${manifest.minAppVersion}" is not x.y.z`);
	}
	if (String(manifest.description ?? "").length > 250) {
		errors.push(`manifest.json description is ${manifest.description.length} characters (Obsidian allows 250)`);
	}

	// ── Version consistency ───────────────────────────────────────────────────
	if (pkg.version !== version) {
		errors.push(`package.json version ${pkg.version} does not match manifest.json ${version}`);
	}
	if (lock && lock.version !== version) {
		errors.push(`package-lock.json version ${lock.version} does not match manifest.json ${version}`);
	}
	if (versions) {
		if (!(version in versions)) {
			errors.push(`versions.json has no entry for ${version}`);
		} else if (versions[version] !== manifest.minAppVersion) {
			errors.push(`versions.json maps ${version} to ${versions[version]}, manifest.json says ${manifest.minAppVersion}`);
		}
	}

	// ── Tag ───────────────────────────────────────────────────────────────────
	const tags = await gitTags();
	if (tags === null) {
		warnings.push("git tags could not be listed, so the tag/version match was not verified");
	} else if (!tags.includes(String(version))) {
		// A pull request that bumps the version legitimately has no tag yet, so
		// this is a warning on a pull request and an error on main.
		const onMain = process.env.GITHUB_REF_NAME === "main" || process.env.GITHUB_EVENT_NAME === "push";
		const message = `no git tag "${version}" exists, so manifest.json points at a version that was never released`;
		if (onMain) errors.push(message);
		else warnings.push(`${message} (expected while the release is still being prepared)`);
	} else {
		notes.push(`git tag ${version} exists`);
	}
}

// ── Release artefacts ───────────────────────────────────────────────────────
const mainSize = await fileSize("main.js");
if (mainSize === null) errors.push("main.js does not exist — run `npm run build`");
else if (mainSize === 0) errors.push("main.js is empty");
else notes.push(`main.js is ${mainSize} bytes`);

const stylesSize = await fileSize("styles.css");
if (stylesSize === null) {
	notes.push("styles.css is absent; it may be omitted from the release if the plugin ships no styles");
} else if (stylesSize === 0) {
	errors.push("styles.css exists but is empty");
} else {
	notes.push(`styles.css is ${stylesSize} bytes`);
}

if ((await fileSize("manifest.json")) === null) errors.push("manifest.json does not exist");

// ── Output ──────────────────────────────────────────────────────────────────
for (const note of notes) console.log(`ok       ${note}`);
for (const warning of warnings) console.log(`warning  ${warning}`);
for (const error of errors) console.error(`::error::${error}`);

if (errors.length) {
	console.error(`\n${errors.length} artefact/manifest problem(s). Refusing to report success.`);
	process.exit(1);
}
console.log(`\nManifest, versions and release artefacts are consistent${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`);
