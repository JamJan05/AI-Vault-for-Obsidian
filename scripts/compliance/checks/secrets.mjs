/**
 * Secret scanning.
 *
 * Scope: everything tracked by git, plus the built bundle when it exists. The
 * point is not to find every possible secret shape, but to guarantee that the
 * specific credentials this plugin handles — OpenAI keys, Anthropic keys, bearer
 * tokens, the Local API key — never end up committed, bundled or published.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { STATUS, finding, result } from "../lib/model.mjs";

/** Marker that a credential-shaped literal is a deliberate, synthetic fixture. */
const FIXTURE_MARKERS = ["EXAMPLENOTAREALKEY", "NOTAREALSECRET", "REDACTED", "PLACEHOLDER"];

const PATTERNS = [
	{ id: "openai-key", label: "OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, severity: "critical" },
	{ id: "anthropic-key", label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, severity: "critical" },
	{ id: "bearer-token", label: "Bearer token literal", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, severity: "high" },
	{ id: "github-token", label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, severity: "critical" },
	{ id: "aws-key", label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/g, severity: "critical" },
	{ id: "private-key", label: "PEM private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, severity: "critical" },
	{ id: "slack-token", label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, severity: "high" },
];

/** Files that are never worth scanning and would only produce noise. */
const SKIP = /(^|\/)(package-lock\.json|LICENSE|styles\.css)$|\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf)$/;

/** Paths where credential-shaped fixtures are expected, provided they are marked. */
const FIXTURE_PATHS = ["tests/", ".compliance/fixtures/"];

function isFixture(path, text) {
	if (!FIXTURE_PATHS.some(prefix => path.startsWith(prefix))) return false;
	return FIXTURE_MARKERS.some(marker => text.includes(marker));
}

export async function run(ctx) {
	const out = [];
	const findings = [];
	const unmarkedFixtures = [];

	// Includes files that are staged for a future commit but not committed yet.
	const candidates = ctx.scannableFiles ?? ctx.trackedFiles ?? [];
	if (!candidates.length) {
		out.push(result({
			id: "secret-scan",
			title: "No credential is committed to the repository",
			status: STATUS.BLOCKED,
			reason: "The file list could not be read from git, so the working tree could not be scanned.",
			rule: "SEC-SCAN-001",
			source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-code",
			summary: "git ls-files produced no output.",
			remediation: "Run the scan inside a git checkout.",
			blocksRelease: true,
		}));
		return out;
	}

	for (const rel of candidates) {
		if (SKIP.test(rel)) continue;
		let text;
		try {
			text = await readFile(join(ctx.root, rel), "utf8");
		} catch {
			continue; // deleted, binary, or unreadable — nothing to scan
		}

		for (const { id, label, pattern, severity } of PATTERNS) {
			pattern.lastIndex = 0;
			let match;
			while ((match = pattern.exec(text)) !== null) {
				const lineNumber = text.slice(0, match.index).split("\n").length;
				const line = text.split("\n")[lineNumber - 1] ?? "";
				const record = finding({
					file: rel,
					line: lineNumber,
					// The match itself is never stored. Only its shape and length are.
					evidence: `${label} shape, ${match[0].length} characters`,
					detail: `${label} (${id})`,
					severity,
				});
				if (isFixture(rel, match[0])) continue;
				if (FIXTURE_PATHS.some(prefix => rel.startsWith(prefix))) {
					unmarkedFixtures.push(record);
				} else {
					findings.push(record);
				}
			}
		}
	}

	out.push(result({
		id: "secret-scan",
		title: "No credential is committed to the repository",
		status: findings.length ? STATUS.FAIL : STATUS.PASS,
		severity: "critical",
		rule: "SEC-SCAN-001",
		source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-code",
		summary: findings.length
			? `${findings.length} credential-shaped literal(s) in the working tree`
			: `${candidates.length} file(s) scanned (tracked and not-yet-committed), no credential found`,
		findings,
		remediation: "Remove the credential, rotate it at the provider, and rewrite the history if it was ever pushed.",
	}));

	if (unmarkedFixtures.length) {
		out.push(result({
			id: "secret-scan-fixtures",
			title: "Test fixtures use clearly synthetic credentials",
			status: STATUS.FAIL,
			severity: "high",
			rule: "SEC-SCAN-002",
			source: "https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html",
			summary: `${unmarkedFixtures.length} credential-shaped literal(s) in test or fixture paths without a synthetic marker`,
			findings: unmarkedFixtures,
			remediation: `Include one of ${FIXTURE_MARKERS.join(", ")} in the literal so it is unmistakably fake.`,
		}));
	}

	// ── Bundle ──────────────────────────────────────────────────────────────
	if (ctx.bundle) {
		const bundleFindings = [];
		for (const { label, pattern, severity } of PATTERNS) {
			pattern.lastIndex = 0;
			let match;
			while ((match = pattern.exec(ctx.bundle)) !== null) {
				bundleFindings.push(finding({
					file: "main.js",
					evidence: `${label} shape, ${match[0].length} characters`,
					detail: `${label} present in the built bundle`,
					severity,
				}));
			}
		}
		out.push(result({
			id: "bundle-secret-scan",
			title: "The built bundle contains no credential",
			status: bundleFindings.length ? STATUS.FAIL : STATUS.PASS,
			severity: "critical",
			rule: "SEC-SCAN-003",
			source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-builds",
			summary: bundleFindings.length ? `${bundleFindings.length} credential shape(s) in main.js` : "main.js contains no credential-shaped literal",
			findings: bundleFindings,
			remediation: "A credential in the bundle means it was hardcoded in the source. Remove it and rotate the key.",
		}));
	} else {
		out.push(result({
			id: "bundle-secret-scan",
			title: "The built bundle contains no credential",
			status: STATUS.BLOCKED,
			reason: "main.js does not exist, so the release artefact could not be scanned. Run `npm run build` before the compliance run.",
			rule: "SEC-SCAN-003",
			source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-builds",
			summary: "No bundle to scan.",
			remediation: "Build the plugin, then re-run the scan.",
			blocksRelease: true,
		}));
	}

	return out;
}
