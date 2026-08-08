/**
 * Tests for the compliance controller itself.
 *
 * A check that never fires is indistinguishable from a check that is broken, so
 * every fixture in `.compliance/fixtures/` is a deliberately non-compliant input
 * that the corresponding check must reject.
 *
 * The fixtures are also driven through the production security modules, so the
 * documented policy and the shipped behaviour cannot drift apart silently.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { assessLocalBaseUrl } from "../../src/security/urlPolicy";
import { safeJoinInside } from "../../src/security/paths";
import { redactSecrets, sanitizeErrorDetail } from "../../src/security/redact";

import * as obsidianPolicy from "../../scripts/compliance/checks/obsidian-policy.mjs";
import * as docsChecks from "../../scripts/compliance/checks/docs.mjs";
import * as releaseChecks from "../../scripts/compliance/checks/release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, ".compliance", "fixtures");

const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const readFixtureJson = <T>(name: string): T => JSON.parse(readFixture(name)) as T;

const projectPolicy = readFixtureJson<Record<string, unknown>>("../ai-vault-policy.json");
const obsidianPolicyMap = readFixtureJson<{ rules: Array<{ id: string; source: string }> }>("../obsidian-policy-map.json");

// ─── Minimal context, matching the shape scripts/compliance/lib/context.mjs builds ──

interface SourceFile { rel: string; text: string; lines: string[] }

function stripComments(line: string): string {
	return line
		.replace(/^\s*(?:\/\/|\/\*+|\*+\/?)\s?.*$/, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/([^:"'`])\/\/.*$/, "$1");
}

function makeContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const sources = new Map<string, SourceFile>();

	const base = {
		root: ROOT,
		redaction: { redactSecrets, sanitizeErrorDetail },
		obsidianPolicy: obsidianPolicyMap,
		projectPolicy,
		manifest: { id: "ai-vault", name: "AI-Vault", version: "1.1.1", minAppVersion: "1.7.2", description: "Fixture." },
		pkg: { name: "ai-vault", version: "1.1.1", license: "MIT" },
		versions: { "1.1.1": "1.7.2" },
		lock: { version: "1.1.1", lockfileVersion: 3, packages: {} },
		sources,
		workflows: new Map(),
		docs: { readme: "", privacy: "", security: "", checks: "", license: "MIT", gitignore: "main.js\n" },
		bundle: "",
		trackedFiles: [],
		tags: ["1.1.1"],
		rule(id: string) {
			return obsidianPolicyMap.rules.find(r => r.id === id) ?? null;
		},
		ruleMeta(id: string) {
			const rule = (this as { rule(id: string): { id: string; source: string } | null }).rule(id);
			return rule ? { rule: rule.id, source: rule.source } : {};
		},
		grepSources(pattern: RegExp, options: { exclude?: string[]; skipComments?: boolean; skipFile?: (f: SourceFile) => boolean } = {}) {
			const hits: Array<{ file: string; line: number; evidence: string }> = [];
			for (const file of (this as { sources: Map<string, SourceFile> }).sources.values()) {
				if (options.exclude?.some(fragment => file.rel.includes(fragment))) continue;
				if (options.skipFile?.(file)) continue;
				file.lines.forEach((line, index) => {
					const subject = options.skipComments ? stripComments(line) : line;
					if (!subject.trim()) return;
					pattern.lastIndex = 0;
					if (pattern.test(subject)) hits.push({ file: file.rel, line: index + 1, evidence: line.trim() });
				});
			}
			return hits;
		},
		activeException() {
			return null;
		},
	};

	return { ...base, ...overrides };
}

function addSource(ctx: Record<string, unknown>, rel: string, text: string): void {
	(ctx.sources as Map<string, SourceFile>).set(rel, { rel, text, lines: text.split("\n") });
}

const byId = (results: Array<{ id: string }>, id: string) => {
	const found = results.find(r => r.id === id);
	assert.ok(found, `check "${id}" did not produce a result`);
	return found as { id: string; status: string; findings: unknown[]; summary: string };
};

// ─── Fixture: Base URLs ─────────────────────────────────────────────────────────

describe("fixture: Local API Base URLs", () => {
	const fixture = readFixtureJson<{
		cases: Array<{ id: string; url: string; expect: Record<string, unknown> }>;
	}>("base-urls.json");

	it("covers loopback, remote, look-alike and forbidden cases", () => {
		const verdicts = new Set(fixture.cases.map(c => c.expect.verdict));
		assert.ok(verdicts.has("loopback-http"), "a valid localhost HTTP case is required");
		assert.ok(verdicts.has("remote-http"), "a remote HTTP case is required");
		assert.ok(verdicts.has("invalid"), "a forbidden-protocol case is required");
	});

	for (const testCase of fixture.cases) {
		it(`classifies ${testCase.id} as expected`, () => {
			const actual = assessLocalBaseUrl(testCase.url) as unknown as Record<string, unknown>;
			for (const [key, expected] of Object.entries(testCase.expect)) {
				assert.equal(actual[key], expected, `${testCase.id}: ${key}`);
			}
		});
	}

	it("never marks a forbidden scheme as usable", () => {
		for (const testCase of fixture.cases.filter(c => c.id.startsWith("forbidden-"))) {
			assert.equal(assessLocalBaseUrl(testCase.url).usable, false, testCase.id);
		}
	});
});

// ─── Fixture: path traversal ────────────────────────────────────────────────────

describe("fixture: storage path traversal", () => {
	const fixture = readFixtureJson<{
		base: string;
		cases: Array<{ id: string; segments: string[]; allowed: boolean }>;
	}>("path-traversal.json");

	for (const testCase of fixture.cases) {
		it(`${testCase.allowed ? "accepts" : "refuses"} ${testCase.id}`, () => {
			const joined = safeJoinInside(fixture.base, ...testCase.segments);
			if (testCase.allowed) {
				assert.ok(joined, `${testCase.id} should have been joined`);
				assert.ok(joined.startsWith(fixture.base), `${testCase.id} escaped the base directory`);
			} else {
				// null means "refuse the operation". Falling back to the base
				// directory would silently write to the wrong file.
				assert.equal(joined, null, `${testCase.id} was not refused`);
			}
		});
	}
});

// ─── Fixture: leaked credentials ────────────────────────────────────────────────

describe("fixture: leaked credentials", () => {
	const fixture = readFixture("leaked-key.txt");

	it("is synthetic and marked as such", () => {
		// Guards the fixture itself: a real key must never land here.
		assert.ok(fixture.includes("EXAMPLENOTAREALKEY"), "the fixture must carry the synthetic marker");
	});

	it("is fully redacted by the shipped redaction function", () => {
		const redacted = redactSecrets(fixture);
		assert.ok(!redacted.includes("sk-EXAMPLENOTAREALKEY0000000000000000000000"));
		assert.ok(!redacted.includes("sk-ant-EXAMPLENOTAREALKEY00000000000000000000"));
		assert.ok(!redacted.includes("EXAMPLENOTAREALKEYtoken0000000000000000"));
	});

	it("survives sanitizeErrorDetail without leaking a credential", () => {
		const detail = sanitizeErrorDetail(fixture, 4000);
		assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(detail), "an OpenAI-shaped key survived sanitization");
		assert.ok(!/Bearer\s+[A-Za-z0-9]{20,}/.test(detail), "a bearer token survived sanitization");
	});
});

// ─── Fixture: credentials and note content in logs ──────────────────────────────

describe("fixture: Authorization and note content in logs", () => {
	it("makes the logging-hygiene check fail", async () => {
		const ctx = makeContext();
		addSource(ctx, "src/fixture/badLogging.ts", readFixture("authorization-logging.ts.txt"));

		const results = await obsidianPolicy.run(ctx);
		const check = byId(results, "logging-hygiene");

		assert.equal(check.status, "FAIL", `logging-hygiene should fail; got ${check.status}: ${check.summary}`);
		assert.ok(check.findings.length >= 3, "each leaking log line should be reported");
	});

	it("passes for logs that carry only a sanitized error message and a path", async () => {
		const ctx = makeContext();
		addSource(ctx, "src/fixture/goodLogging.ts", [
			'console.warn("[AI-Vault] readJson failed:", filePath, (e as Error)?.message);',
			'console.error("[AI-Vault] writeJson failed:", filePath, errorMessage(e));',
			'console.warn("[AI-Vault] file failed:", file.path, (e as Error)?.message);',
		].join("\n"));

		const results = await obsidianPolicy.run(ctx);
		assert.equal(byId(results, "logging-hygiene").status, "PASS");
	});
});

// ─── Fixture: missing privacy sections ──────────────────────────────────────────

describe("fixture: privacy document with the required sections removed", () => {
	it("makes the required-doc-sections check fail", async () => {
		const ctx = makeContext({
			docs: {
				readme: "# AI-Vault\n\nNetwork use: api.openai.com. API key required.",
				privacy: readFixture("missing-privacy-section.md"),
				security: "# Security\n\nReporting a vulnerability. Do not post an API key, a note or a log.\n\nSupported versions",
				checks: "# Checks",
				license: "MIT",
				gitignore: "main.js\n",
			},
		});

		const results = await docsChecks.run(ctx);
		const check = byId(results, "required-doc-sections");

		assert.equal(check.status, "FAIL", `required-doc-sections should fail; got ${check.status}`);
		assert.ok(check.findings.length > 0, "the missing sections should be listed individually");
	});

	it("makes security-policy-warnings fail when SECURITY.md is absent", async () => {
		const ctx = makeContext({
			docs: { readme: "", privacy: "", security: null, checks: "", license: "MIT", gitignore: "" },
		});
		const results = await docsChecks.run(ctx);
		assert.equal(byId(results, "security-policy-warnings").status, "FAIL");
	});
});

// ─── Fixture: version mismatch ──────────────────────────────────────────────────

describe("fixture: disagreeing version metadata", () => {
	const fixture = readFixtureJson<{
		manifest: Record<string, unknown>;
		package: Record<string, unknown>;
		lock: Record<string, unknown>;
		versions: Record<string, string>;
		tags: string[];
		expectedProblems: string[];
	}>("version-mismatch.json");

	it("makes the version-consistency check fail and names every disagreement", async () => {
		const ctx = makeContext({
			manifest: fixture.manifest,
			pkg: fixture.package,
			lock: fixture.lock,
			versions: fixture.versions,
			tags: fixture.tags,
			workflows: new Map(),
			bundle: "",
		});

		const results = await releaseChecks.run(ctx);
		const check = byId(results, "version-consistency");

		assert.equal(check.status, "FAIL", `version-consistency should fail; got ${check.status}`);
		for (const expected of fixture.expectedProblems) {
			assert.ok(
				check.summary.includes(expected),
				`the summary should name the ${expected} disagreement; got: ${check.summary}`,
			);
		}
	});

	it("passes when every version agrees and the tag exists", async () => {
		const ctx = makeContext({ workflows: new Map(), bundle: "" });
		const results = await releaseChecks.run(ctx);
		assert.equal(byId(results, "version-consistency").status, "PASS");
	});
});

// ─── The checks must not be trivially green ─────────────────────────────────────

describe("controller sanity", () => {
	it("fails no-html-injection-sinks on an innerHTML assignment", async () => {
		const ctx = makeContext();
		addSource(ctx, "src/fixture/sink.ts", 'el.innerHTML = `<b>${userInput}</b>`;');
		const results = await obsidianPolicy.run(ctx);
		assert.equal(byId(results, "no-html-injection-sinks").status, "FAIL");
	});

	it("fails request-url-only on a direct fetch call", async () => {
		const ctx = makeContext();
		addSource(ctx, "src/fixture/net.ts", 'const r = await fetch("https://api.openai.com/v1/models");');
		const results = await obsidianPolicy.run(ctx);
		assert.equal(byId(results, "request-url-only").status, "FAIL");
	});

	it("does not fail request-url-only on a comment that merely mentions fetch", async () => {
		const ctx = makeContext();
		addSource(ctx, "src/fixture/net.ts", "// Uses Obsidian requestUrl(), not fetch(), per the guidelines.");
		const results = await obsidianPolicy.run(ctx);
		assert.equal(byId(results, "request-url-only").status, "PASS");
	});

	it("fails manifest-desktop-only when a Node built-in is imported without the flag", async () => {
		const ctx = makeContext({
			manifest: { id: "ai-vault", name: "AI-Vault", version: "1.1.1", minAppVersion: "1.7.2", description: "Fixture.", isDesktopOnly: false },
		});
		addSource(ctx, "src/fixture/fs.ts", 'import * as fs from "fs/promises";');
		const results = await obsidianPolicy.run(ctx);
		assert.equal(byId(results, "manifest-desktop-only").status, "FAIL");
	});
});
