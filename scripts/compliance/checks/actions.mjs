/**
 * GitHub Actions hardening checks.
 *
 * Reference: https://docs.github.com/en/actions/reference/security/secure-use
 */

import { STATUS, finding, result } from "../lib/model.mjs";

const USES = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s*#\s*(.*))?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Expressions that interpolate attacker-controllable text straight into a shell. */
const INJECTABLE_CONTEXTS = [
	"github.event.issue.title",
	"github.event.issue.body",
	"github.event.pull_request.title",
	"github.event.pull_request.body",
	"github.event.comment.body",
	"github.event.review.body",
	"github.event.review_comment.body",
	"github.event.head_commit.message",
	"github.event.pull_request.head.ref",
	"github.event.pull_request.head.repo.default_branch",
	"github.head_ref",
];

/**
 * Workflow body with `#` comments removed.
 *
 * Behavioural checks must read what a workflow does, not what its comments say.
 * This file's own workflows explain *why* they avoid `pull_request_target`, and a
 * naive text match would report that explanation as a usage.
 *
 * Only full-line and trailing comments are stripped; `#` inside a quoted string
 * (a cron expression, a colour) stays, which is why the quote state is tracked.
 */
function stripYamlComments(text) {
	return text
		.split("\n")
		.map(line => {
			let quote = null;
			for (let i = 0; i < line.length; i += 1) {
				const char = line[i];
				if (quote) {
					if (char === quote) quote = null;
					continue;
				}
				if (char === '"' || char === "'") { quote = char; continue; }
				if (char === "#") return line.slice(0, i).trimEnd();
			}
			return line;
		})
		.join("\n");
}

export async function run(ctx) {
	const out = [];

	if (ctx.workflows.size === 0) {
		out.push(result({
			id: "actions-present",
			title: "GitHub Actions workflows exist",
			status: STATUS.NOT_APPLICABLE,
			reason: "No workflow files were found under .github/workflows.",
			summary: "Nothing to audit.",
		}));
		return out;
	}

	// ── Action pinning ──────────────────────────────────────────────────────
	{
		const unpinned = [];
		const pinned = [];
		for (const wf of ctx.workflows.values()) {
			wf.text.split("\n").forEach((line, index) => {
				const match = USES.exec(line);
				if (!match) return;
				const [, ref, comment] = match;
				// A local action (./…) and a docker:// image are out of scope for SHA pinning.
				if (ref.startsWith("./") || ref.startsWith("docker://")) return;
				const version = ref.split("@")[1] ?? "";
				if (FULL_SHA.test(version)) {
					pinned.push({ file: wf.rel, line: index + 1, ref, comment: comment ?? null });
					if (!comment || !/v?\d+(\.\d+)*/.test(comment)) {
						unpinned.push(finding({
							file: wf.rel, line: index + 1, evidence: line.trim(),
							detail: `${ref.split("@")[0]} is SHA-pinned but has no version comment`,
							severity: "low",
						}));
					}
				} else {
					unpinned.push(finding({
						file: wf.rel, line: index + 1, evidence: line.trim(),
						detail: `${ref} is pinned to a mutable ref, not a full 40-character commit SHA`,
						severity: "high",
					}));
				}
			});
		}

		const hard = unpinned.filter(f => f.severity === "high");
		out.push(result({
			id: "actions-sha-pinning",
			title: "Every third-party action is pinned to a full commit SHA",
			status: hard.length ? STATUS.FAIL : unpinned.length ? STATUS.WARNING : STATUS.PASS,
			severity: hard.length ? "high" : "low",
			rule: "GHA-PIN-001",
			source: "https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions",
			summary: hard.length
				? `${hard.length} action reference(s) use a mutable tag`
				: `${pinned.length} action reference(s), all pinned to a full SHA`,
			findings: unpinned,
			remediation: "Replace the tag with the full 40-character commit SHA of a verified release and add `# vX.Y.Z` after it.",
		}));
	}

	// ── Permissions ─────────────────────────────────────────────────────────
	{
		const problems = [];
		for (const wf of ctx.workflows.values()) {
			const body = stripYamlComments(wf.text);
			if (!/^permissions:/m.test(body)) {
				problems.push(finding({ file: wf.rel, detail: "no top-level permissions block; the workflow inherits the repository default", severity: "high" }));
				continue;
			}
			if (/^permissions:\s*write-all\s*$/m.test(body)) {
				problems.push(finding({ file: wf.rel, detail: "permissions: write-all grants every scope", severity: "critical" }));
			}
			const writes = [...body.matchAll(/^\s{2,}([a-z-]+):\s*write\s*$/gm)].map(m => m[1]);
			if (writes.length && !/on:\s*[\s\S]*?release:/.test(body) && !/workflow_dispatch/.test(body)) {
				problems.push(finding({ file: wf.rel, detail: `write scopes granted (${writes.join(", ")}) in a workflow that is not the publisher`, severity: "medium" }));
			}
		}

		out.push(result({
			id: "actions-permissions",
			title: "Workflows declare least-privilege permissions",
			status: problems.some(p => p.severity === "critical" || p.severity === "high") ? STATUS.FAIL
				: problems.length ? STATUS.WARNING : STATUS.PASS,
			severity: problems.length ? "high" : "low",
			rule: "GHA-PERM-001",
			source: "https://docs.github.com/en/actions/reference/security/secure-use#using-the-github_token-in-a-workflow",
			summary: problems.length ? `${problems.length} permission issue(s)` : `all ${ctx.workflows.size} workflow(s) declare explicit permissions`,
			findings: problems,
			remediation: "Start every workflow with `permissions: contents: read` and grant a write scope only on the specific job that needs it.",
		}));
	}

	// ── pull_request_target ─────────────────────────────────────────────────
	{
		const offenders = [];
		for (const wf of ctx.workflows.values()) {
			const body = stripYamlComments(wf.text);
			if (!/pull_request_target/.test(body)) continue;
			const buildsPrCode = /actions\/checkout[\s\S]{0,400}?ref:\s*\$\{\{\s*github\.event\.pull_request\.head/.test(body)
				|| /npm (ci|install|run build)/.test(body);
			offenders.push(finding({
				file: wf.rel,
				detail: buildsPrCode
					? "pull_request_target is used in a workflow that checks out or builds PR code — this exposes repository secrets to a fork"
					: "pull_request_target is used; verify it never runs code from the pull request",
				severity: buildsPrCode ? "critical" : "medium",
			}));
		}

		out.push(result({
			id: "actions-pull-request-target",
			title: "pull_request_target is not used to build or run pull-request code",
			status: offenders.some(o => o.severity === "critical") ? STATUS.FAIL
				: offenders.length ? STATUS.MANUAL_REVIEW : STATUS.PASS,
			severity: "critical",
			reason: offenders.length && !offenders.some(o => o.severity === "critical")
				? "pull_request_target appears in a workflow; a human must confirm it never executes code from the pull request."
				: undefined,
			rule: "GHA-PRT-001",
			source: "https://docs.github.com/en/actions/reference/security/secure-use#understanding-the-risk-of-script-injections",
			summary: offenders.length ? `${offenders.length} pull_request_target usage(s)` : "no workflow uses pull_request_target",
			findings: offenders,
			remediation: "Use `pull_request` for anything that builds contributor code. Keep privileged work in a separate, non-building workflow.",
		}));
	}

	// ── Script injection ────────────────────────────────────────────────────
	{
		const offenders = [];
		for (const wf of ctx.workflows.values()) {
			stripYamlComments(wf.text).split("\n").forEach((line, index) => {
				for (const context of INJECTABLE_CONTEXTS) {
					if (line.includes(`\${{ ${context}`) || line.includes(`\${{${context}`)) {
						offenders.push(finding({
							file: wf.rel, line: index + 1, evidence: line.trim(),
							detail: `${context} is interpolated directly; route it through an env variable instead`,
							severity: "high",
						}));
					}
				}
			});
		}

		out.push(result({
			id: "actions-script-injection",
			title: "No attacker-controllable context is interpolated into a shell",
			status: offenders.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			rule: "GHA-INJ-001",
			source: "https://docs.github.com/en/actions/reference/security/secure-use#understanding-the-risk-of-script-injections",
			summary: offenders.length ? `${offenders.length} injectable interpolation(s)` : "no untrusted GitHub context is interpolated into a run step",
			findings: offenders,
			remediation: "Bind the value to an `env:` variable and reference it as \"$VAR\" inside the shell, so it is never expanded by the workflow templating engine.",
		}));
	}

	// ── persist-credentials ─────────────────────────────────────────────────
	{
		const problems = [];
		for (const wf of ctx.workflows.values()) {
			const checkouts = [...wf.text.matchAll(/uses:\s*actions\/checkout@[^\n]*\n((?:\s+[^\n]*\n)*)/g)];
			for (const [, block] of checkouts) {
				const pushesLater = /git push|gh release (create|upload)/.test(wf.text);
				if (!/persist-credentials:\s*false/.test(block) && !pushesLater) {
					problems.push(finding({
						file: wf.rel,
						detail: "actions/checkout leaves the token in .git/config although the workflow never pushes",
						severity: "medium",
					}));
				}
			}
		}

		out.push(result({
			id: "actions-persist-credentials",
			title: "Checkout does not keep credentials when they are not needed",
			status: problems.length ? STATUS.WARNING : STATUS.PASS,
			severity: "medium",
			rule: "GHA-CRED-001",
			source: "https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-github-hosted-runners",
			summary: problems.length ? `${problems.length} checkout(s) without persist-credentials: false` : "checkout credentials are only kept where a push happens",
			findings: problems,
			remediation: "Add `persist-credentials: false` to every checkout that does not later push.",
		}));
	}

	// ── Timeouts, concurrency, secret echo, curl|sh ─────────────────────────
	{
		const problems = [];
		for (const wf of ctx.workflows.values()) {
			const body = stripYamlComments(wf.text);
			if (!/timeout-minutes:/.test(body)) {
				problems.push(finding({ file: wf.rel, detail: "no job declares timeout-minutes", severity: "low" }));
			}
			if (!/^concurrency:/m.test(body) && /pull_request/.test(body)) {
				problems.push(finding({ file: wf.rel, detail: "no concurrency group, so superseded pull-request runs keep burning minutes", severity: "low" }));
			}
			if (/curl[^\n|]*\|\s*(ba)?sh/.test(body) || /wget[^\n|]*\|\s*(ba)?sh/.test(body)) {
				problems.push(finding({ file: wf.rel, detail: "pipes a downloaded script straight into a shell", severity: "critical" }));
			}
			body.split("\n").forEach((line, index) => {
				if (/echo[^\n]*\$\{\{\s*secrets\./.test(line) || /printf[^\n]*\$\{\{\s*secrets\./.test(line)) {
					problems.push(finding({ file: wf.rel, line: index + 1, evidence: line.trim(), detail: "a secret is echoed to the log", severity: "critical" }));
				}
			});
			if (/continue-on-error:\s*true/.test(body)) {
				problems.push(finding({ file: wf.rel, detail: "continue-on-error: true — confirm the step is genuinely informational", severity: "medium" }));
			}
		}

		const severe = problems.filter(p => p.severity === "critical");
		out.push(result({
			id: "actions-hardening",
			title: "Workflows are hardened: timeouts, concurrency, no secret echo, no curl-to-shell",
			status: severe.length ? STATUS.FAIL : problems.length ? STATUS.WARNING : STATUS.PASS,
			severity: severe.length ? "critical" : "low",
			rule: "GHA-HARD-001",
			source: "https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html",
			summary: problems.length ? `${problems.length} hardening issue(s)` : "timeouts, concurrency and log hygiene are all in place",
			findings: problems,
			remediation: "Add timeout-minutes and a concurrency group, never echo a secret, and install tools from a pinned action or the package manager rather than curl | sh.",
		}));
	}

	// ── Secrets on pull-request workflows ───────────────────────────────────
	{
		const problems = [];
		for (const wf of ctx.workflows.values()) {
			const body = stripYamlComments(wf.text);
			const isPr = /^on:[\s\S]*?pull_request:/m.test(body);
			if (!isPr) continue;
			const secretUses = [...body.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map(m => m[1]);
			const nonDefault = secretUses.filter(name => name !== "GITHUB_TOKEN");
			if (nonDefault.length) {
				problems.push(finding({ file: wf.rel, detail: `pull-request workflow references repository secret(s): ${[...new Set(nonDefault)].join(", ")}`, severity: "critical" }));
			}
		}

		out.push(result({
			id: "actions-pr-secrets",
			title: "Pull-request workflows receive no repository secrets",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "critical",
			rule: "GHA-SEC-001",
			source: "https://docs.github.com/en/actions/reference/security/secure-use#using-secrets",
			summary: problems.length ? `${problems.length} workflow(s) expose secrets to pull requests` : "no pull-request workflow references a repository secret",
			findings: problems,
			remediation: "Move any step that needs a secret into a workflow that does not run on contributor pull requests.",
		}));
	}

	return out;
}
