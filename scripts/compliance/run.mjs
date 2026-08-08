/**
 * Compliance runner.
 *
 * Runs every check, aggregates the results, writes the JSON, SARIF and Markdown
 * reports, appends to GITHUB_STEP_SUMMARY, and exits non-zero when anything
 * blocks a release.
 *
 * Design rules this file follows:
 * - A check that throws becomes a BLOCKED result and keeps the run going. One
 *   broken check must not hide the state of the other twenty.
 * - The report generator itself is wrapped: if it fails, the job still fails, a
 *   minimal fallback summary is written, and the missing report is recorded as an
 *   additional blocker.
 * - Nothing here can turn a FAIL into a WARNING.
 *
 * Usage: node scripts/compliance/run.mjs [--out <dir>]
 */

import { appendFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import { createContext, ROOT } from "./lib/context.mjs";
import { STATUS, result } from "./lib/model.mjs";
import { createRenderer, summarize, toJson, toMarkdown, toSarif } from "./lib/report.mjs";
import { buildSbom, validateSbom } from "./sbom.mjs";

import * as obsidianPolicy from "./checks/obsidian-policy.mjs";
import * as privacy from "./checks/privacy.mjs";
import * as codeSecurity from "./checks/code-security.mjs";
import * as supplyChain from "./checks/supply-chain.mjs";
import * as actions from "./checks/actions.mjs";
import * as secrets from "./checks/secrets.mjs";
import * as release from "./checks/release.mjs";
import * as docs from "./checks/docs.mjs";

const SUITES = [
	["Obsidian policy", obsidianPolicy],
	["Privacy and network", privacy],
	["Code security", codeSecurity],
	["Supply chain", supplyChain],
	["GitHub Actions", actions],
	["Secret scanning", secrets],
	["Release integrity", release],
	["Documentation", docs],
];

function parseArgs(argv) {
	const outIndex = argv.indexOf("--out");
	return { outDir: outIndex >= 0 ? resolve(argv[outIndex + 1]) : ROOT };
}

function runContextFromEnv() {
	const env = process.env;
	return {
		repository: env.GITHUB_REPOSITORY ?? "local checkout",
		commit: env.GITHUB_SHA ?? "local working tree",
		ref: env.GITHUB_REF_NAME ?? env.GITHUB_HEAD_REF ?? "local",
		pullRequest: env.GITHUB_EVENT_NAME === "pull_request" ? (env.GITHUB_REF_NAME ?? "unknown") : "not a pull request",
		event: env.GITHUB_EVENT_NAME ?? "manual",
		runId: env.GITHUB_RUN_ID ?? "n/a",
		workflow: env.GITHUB_WORKFLOW ?? "local",
		startedAt: new Date().toISOString(),
	};
}

async function runSuite(name, module, ctx) {
	try {
		const results = await module.run(ctx);
		if (!Array.isArray(results)) throw new Error(`${name} did not return an array of results`);
		return results;
	} catch (error) {
		// A crashed suite is BLOCKED, never silently absent and never a pass.
		return [result({
			id: `suite-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
			title: `${name} checks`,
			status: STATUS.BLOCKED,
			reason: `The check suite threw: ${ctx.redaction.sanitizeErrorDetail(error)}`,
			summary: "The suite did not complete, so none of its checks can be treated as passed.",
			remediation: "Fix the check code, then re-run `npm run compliance`.",
			blocksRelease: true,
		})];
	}
}

async function runSbom(ctx, outDir) {
	try {
		const sbom = await buildSbom();
		const problems = validateSbom(sbom);
		const path = join(outDir, "sbom.cdx.json");
		await writeFile(path, JSON.stringify(sbom, null, 2) + "\n");

		return result({
			id: "sbom",
			title: "A valid CycloneDX SBOM is generated",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "medium",
			rule: "SC-SBOM-001",
			source: "https://owasp.org/www-project-software-component-verification-standard/",
			summary: problems.length
				? `SBOM validation failed: ${problems.slice(0, 3).join("; ")}`
				: `CycloneDX ${sbom.specVersion} with ${sbom.components.length} components written to sbom.cdx.json`,
			remediation: "Fix the component metadata in package-lock.json (usually a missing version or resolved URL) and regenerate.",
		});
	} catch (error) {
		return result({
			id: "sbom",
			title: "A valid CycloneDX SBOM is generated",
			status: STATUS.BLOCKED,
			reason: `SBOM generation failed: ${ctx.redaction.sanitizeErrorDetail(error)}`,
			rule: "SC-SBOM-001",
			source: "https://owasp.org/www-project-software-component-verification-standard/",
			summary: "No SBOM was produced.",
			remediation: "Run `node scripts/compliance/sbom.mjs` locally to see the failure.",
			blocksRelease: true,
		});
	}
}

async function appendStepSummary(text) {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (!path) return;
	await appendFile(path, `${text}\n`).catch(error => {
		console.error("Could not write to GITHUB_STEP_SUMMARY:", error?.message ?? error);
	});
}

async function main() {
	const { outDir } = parseArgs(process.argv.slice(2));
	const runContext = runContextFromEnv();

	const ctx = await createContext();
	const renderer = createRenderer(ctx.redaction);

	/** @type {Array<object>} */
	const results = [];
	for (const [name, module] of SUITES) {
		results.push(...(await runSuite(name, module, ctx)));
	}
	results.push(await runSbom(ctx, outDir));

	const summary = summarize(results);

	// ── Reports ─────────────────────────────────────────────────────────────
	let reportWritten = true;
	let reportError = null;
	const reportName = summary.isGo ? "security-privacy-success-report.md" : "security-privacy-failure-report.md";

	try {
		const markdown = toMarkdown(results, summary, renderer, runContext);
		// Remove the opposite report from an earlier run. Leaving a stale
		// success report next to a fresh failure report invites reading the wrong
		// one, and the artifact upload would collect both.
		const stale = summary.isGo ? "security-privacy-failure-report.md" : "security-privacy-success-report.md";
		await rm(join(outDir, stale), { force: true });
		await writeFile(join(outDir, reportName), markdown);
		await writeFile(join(outDir, "compliance-report.json"), JSON.stringify(toJson(results, summary, runContext), null, 2) + "\n");
		await writeFile(join(outDir, "compliance-report.sarif"), JSON.stringify(toSarif(results, renderer, runContext), null, 2) + "\n");
		await appendStepSummary(markdown);
	} catch (error) {
		reportWritten = false;
		reportError = ctx.redaction.sanitizeErrorDetail(error);
		// The generator failing does not rescue the run and does not hide the
		// original outcome — it adds a blocker of its own.
		const fallback = [
			"# AI-Vault — compliance report generator failed",
			"",
			"## Decision",
			"",
			"NO-GO — do not publish",
			"",
			`The report generator failed: ${reportError}`,
			"",
			`Checks completed: ${summary.total}. PASS ${summary.counts.PASS}, FAIL ${summary.counts.FAIL}, BLOCKED ${summary.counts.BLOCKED}, WARNING ${summary.counts.WARNING}, MANUAL_REVIEW ${summary.counts.MANUAL_REVIEW}.`,
			"",
			"The absence of a full report is itself a publication blocker. The original check outcomes above still stand.",
			"",
		].join("\n");
		await appendStepSummary(fallback);
		await writeFile(join(outDir, "security-privacy-failure-report.md"), fallback).catch(() => {});
	}

	// ── Console output ──────────────────────────────────────────────────────
	const icon = { PASS: "✅", FAIL: "❌", WARNING: "⚠️ ", MANUAL_REVIEW: "🔍", BLOCKED: "⛔", NOT_APPLICABLE: "➖" };
	for (const check of results) {
		console.log(`${icon[check.status]} ${check.status.padEnd(15)} ${check.id.padEnd(32)} ${check.summary || check.reason || ""}`);
	}
	console.log("");
	console.log(`Total ${summary.total}: PASS ${summary.counts.PASS}, FAIL ${summary.counts.FAIL}, WARNING ${summary.counts.WARNING}, BLOCKED ${summary.counts.BLOCKED}, MANUAL_REVIEW ${summary.counts.MANUAL_REVIEW}, NOT_APPLICABLE ${summary.counts.NOT_APPLICABLE}`);
	console.log(`Highest detected risk level: ${summary.highestSeverity}`);
	console.log(`Decision: ${summary.decision}`);
	if (!reportWritten) console.log(`Report generator failed: ${reportError}`);

	const failing = summary.blockers.length > 0 || !reportWritten;
	process.exit(failing ? 1 : 0);
}

main().catch(error => {
	// Last resort: the runner itself could not start. Fail loudly and do not
	// pretend anything was checked.
	console.error("Compliance runner failed to start:", error?.message ?? error);
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (path) {
		import("node:fs").then(fs => {
			fs.appendFileSync(path, `\n# AI-Vault compliance\n\nNO-GO — the compliance runner could not start. No check was executed, so nothing may be treated as passed.\n`);
		}).catch(() => {});
	}
	process.exit(1);
});
