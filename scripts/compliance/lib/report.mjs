/**
 * Report rendering: Markdown, JSON and SARIF.
 *
 * Every string that came from a file, a command or a dependency passes through
 * the project's own `sanitizeErrorDetail` before it is written anywhere, so a
 * report can never leak a credential, a note body or a raw endpoint response.
 */

import { STATUS, SEVERITY_ORDER, countByStatus, highestSeverity } from "./model.mjs";

/** Hard cap on how much evidence any single finding may contribute. */
const MAX_EVIDENCE = 200;
/** Hard cap on how many findings are rendered per check. */
const MAX_FINDINGS_RENDERED = 10;

const SARIF_LEVEL = {
	critical: "error",
	high: "error",
	medium: "warning",
	low: "note",
	informational: "note",
};

export function createRenderer(redaction) {
	const clean = value => redaction.sanitizeErrorDetail(value, MAX_EVIDENCE);

	/** Markdown table cells must not contain a raw pipe or newline. */
	const cell = value => clean(value).replace(/\|/g, "\\|") || "—";

	return { clean, cell, MAX_EVIDENCE, MAX_FINDINGS_RENDERED };
}

export function summarize(results) {
	const counts = countByStatus(results);
	const blockers = results.filter(r => r.blocksRelease);
	return {
		counts,
		total: results.length,
		highestSeverity: highestSeverity(results),
		blockers,
		decision: blockers.length === 0
			? "GO — technically ready to be considered for publication"
			: "NO-GO — do not publish",
		isGo: blockers.length === 0,
	};
}

export function toJson(results, summary, runContext) {
	return {
		schema: "ai-vault-compliance-report/1",
		generatedAt: new Date().toISOString(),
		run: runContext,
		decision: summary.decision,
		summary: {
			total: summary.total,
			...summary.counts,
			highestSeverity: summary.highestSeverity,
			blockingChecks: summary.blockers.map(b => b.id),
		},
		checks: results,
	};
}

export function toSarif(results, renderer, runContext) {
	const rules = new Map();
	const sarifResults = [];

	for (const check of results) {
		if (check.status !== STATUS.FAIL && check.status !== STATUS.WARNING) continue;

		if (!rules.has(check.id)) {
			rules.set(check.id, {
				id: check.id,
				name: check.id.replace(/[^A-Za-z0-9]/g, ""),
				shortDescription: { text: renderer.clean(check.title) },
				fullDescription: { text: renderer.clean(check.remediation ?? check.title) },
				helpUri: check.source ?? "https://docs.obsidian.md/Developer+policies",
				properties: {
					"security-severity": String(securityScore(check.severity)),
					tags: ["security", "privacy", check.rule ?? "policy"].filter(Boolean),
				},
				defaultConfiguration: { level: SARIF_LEVEL[check.severity] ?? "warning" },
			});
		}

		const findings = check.findings.length ? check.findings : [{ file: ".compliance/ai-vault-policy.json", line: null, detail: check.summary }];
		for (const f of findings.slice(0, renderer.MAX_FINDINGS_RENDERED)) {
			sarifResults.push({
				ruleId: check.id,
				level: SARIF_LEVEL[f.severity ?? check.severity] ?? "warning",
				message: { text: renderer.clean(`${check.title}: ${f.detail || check.summary}`) },
				locations: [{
					physicalLocation: {
						artifactLocation: { uri: f.file ?? "manifest.json" },
						...(f.line ? { region: { startLine: f.line } } : {}),
					},
				}],
				partialFingerprints: { checkId: check.id, file: f.file ?? "", line: String(f.line ?? "") },
			});
		}
	}

	return {
		$schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
		version: "2.1.0",
		runs: [{
			tool: {
				driver: {
					name: "AI-Vault compliance",
					informationUri: "https://github.com/JamJan05/AI-Vault-for-Obsidian",
					version: "1.0.0",
					rules: [...rules.values()],
				},
			},
			automationDetails: { id: runContext.workflow ?? "local" },
			results: sarifResults,
		}],
	};
}

function securityScore(severity) {
	return { critical: 9.5, high: 7.5, medium: 5.0, low: 3.0, informational: 1.0 }[severity] ?? 5.0;
}

const STATUS_ICON = {
	PASS: "✅",
	FAIL: "❌",
	WARNING: "⚠️",
	MANUAL_REVIEW: "🔍",
	BLOCKED: "⛔",
	NOT_APPLICABLE: "➖",
};

/**
 * The full Markdown report. The same renderer produces the failure report and the
 * success report; only the decision block and the level of detail differ.
 */
export function toMarkdown(results, summary, renderer, runContext) {
	const lines = [];
	const failed = results.filter(r => r.status === STATUS.FAIL);
	const blocked = results.filter(r => r.status === STATUS.BLOCKED);
	const manual = results.filter(r => r.status === STATUS.MANUAL_REVIEW);
	const warnings = results.filter(r => r.status === STATUS.WARNING);

	lines.push(summary.isGo
		? "# AI-Vault — security and privacy check report"
		: "# AI-Vault — failed security and privacy check report");
	lines.push("");
	lines.push("## Decision");
	lines.push("");
	lines.push(summary.decision);
	lines.push("");
	if (summary.isGo) {
		lines.push("This is a technical recommendation to the repository owner. It is not approval by Obsidian and it does not publish anything.");
	} else {
		lines.push("Do not publish, tag, or create a release until every blocker below is resolved.");
	}
	lines.push("");

	lines.push("## Run context");
	lines.push("");
	for (const [label, value] of Object.entries(runContext)) {
		lines.push(`- **${label}**: ${renderer.cell(String(value ?? "unknown"))}`);
	}
	lines.push("");

	lines.push("## Summary");
	lines.push("");
	lines.push(`- PASS: ${summary.counts.PASS}`);
	lines.push(`- FAIL: ${summary.counts.FAIL}`);
	lines.push(`- WARNING: ${summary.counts.WARNING}`);
	lines.push(`- BLOCKED: ${summary.counts.BLOCKED}`);
	lines.push(`- MANUAL_REVIEW: ${summary.counts.MANUAL_REVIEW}`);
	lines.push(`- NOT_APPLICABLE: ${summary.counts.NOT_APPLICABLE}`);
	lines.push(`- Highest detected risk level: **${summary.highestSeverity}**`);
	lines.push("");

	if (failed.length || blocked.length) {
		lines.push("## Checks that did not pass");
		lines.push("");
		lines.push("| Check | Status | Severity | File/line | Cause | Evidence | Violated rule |");
		lines.push("|---|---|---|---|---|---|---|");
		for (const check of [...failed, ...blocked]) {
			const first = check.findings[0];
			lines.push([
				"",
				renderer.cell(check.title),
				check.status,
				check.severity,
				first ? renderer.cell(`${first.file}${first.line ? `:${first.line}` : ""}`) : "—",
				renderer.cell(check.reason || check.summary),
				first ? renderer.cell(first.evidence || first.detail) : "—",
				check.rule ? renderer.cell(check.rule) : "—",
				"",
			].join(" | ").trim());
		}
		lines.push("");

		lines.push("## What is wrong");
		lines.push("");
		for (const check of [...failed, ...blocked]) {
			lines.push(`### ${STATUS_ICON[check.status]} ${renderer.clean(check.title)} (\`${check.id}\`)`);
			lines.push("");
			lines.push(renderer.clean(check.reason || check.summary));
			lines.push("");
			if (check.findings.length) {
				for (const f of check.findings.slice(0, renderer.MAX_FINDINGS_RENDERED)) {
					const where = `${f.file}${f.line ? `:${f.line}` : ""}`;
					lines.push(`- \`${renderer.clean(where)}\` — ${renderer.clean(f.detail || f.evidence)}`);
				}
				if (check.findings.length > renderer.MAX_FINDINGS_RENDERED) {
					lines.push(`- …and ${check.findings.length - renderer.MAX_FINDINGS_RENDERED} more occurrence(s).`);
				}
				lines.push("");
			}
		}

		lines.push("## How to fix");
		lines.push("");
		lines.push("| Problem | Minimal fix | How to re-test | Expected result |");
		lines.push("|---|---|---|---|");
		for (const check of [...failed, ...blocked]) {
			lines.push([
				"",
				renderer.cell(check.title),
				renderer.cell(check.remediation ?? "See the check description."),
				`\`npm run compliance\``,
				`\`${check.id}\` reports PASS`,
				"",
			].join(" | ").trim());
		}
		lines.push("");
	}

	if (blocked.length || manual.length) {
		lines.push("## Blocked or manual-review items");
		lines.push("");
		lines.push("| Check | Reason | Blocks publication | Required action |");
		lines.push("|---|---|---|---|");
		for (const check of [...blocked, ...manual]) {
			lines.push([
				"",
				renderer.cell(check.title),
				renderer.cell(check.reason ?? check.summary),
				check.blocksRelease ? "yes" : "no",
				renderer.cell(check.remediation ?? "Review and record the decision."),
				"",
			].join(" | ").trim());
		}
		lines.push("");
	}

	if (warnings.length) {
		lines.push("## Warnings");
		lines.push("");
		lines.push("| Check | Severity | Summary |");
		lines.push("|---|---|---|");
		for (const check of warnings) {
			lines.push(`| ${renderer.cell(check.title)} | ${check.severity} | ${renderer.cell(check.summary)} |`);
		}
		lines.push("");
	}

	lines.push("## All checks");
	lines.push("");
	lines.push("| Check | Status | Attempts | Last result | Evidence/log | Blocks publication |");
	lines.push("|---|---|---:|---|---|---|");
	for (const check of [...results].sort(byStatusThenSeverity)) {
		lines.push([
			"",
			renderer.cell(check.title),
			`${STATUS_ICON[check.status]} ${check.status}`,
			String(check.attempts ?? 1),
			renderer.cell(check.summary || check.reason),
			`\`${check.id}\``,
			check.blocksRelease ? "yes" : "no",
			"",
		].join(" | ").trim());
	}
	lines.push("");

	lines.push("## Policy sources");
	lines.push("");
	const sources = new Set(results.map(r => r.source).filter(Boolean));
	for (const source of [...sources].sort()) lines.push(`- ${source}`);
	lines.push("");
	lines.push("---");
	lines.push("");
	lines.push("This report is an automated check of selected safeguards and compliance evidence. It is not a certification of GDPR compliance, and it does not mean the plugin has been approved by Obsidian.");
	lines.push("");

	return lines.join("\n");
}

function byStatusThenSeverity(a, b) {
	const order = { FAIL: 0, BLOCKED: 1, WARNING: 2, MANUAL_REVIEW: 3, PASS: 4, NOT_APPLICABLE: 5 };
	if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
	return SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
}
