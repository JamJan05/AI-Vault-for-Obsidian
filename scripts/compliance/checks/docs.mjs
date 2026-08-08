/**
 * Documentation completeness: the sections that .compliance/ai-vault-policy.json
 * declares as required must actually exist.
 */

import { STATUS, finding, result } from "../lib/model.mjs";

const DOC_KEY = {
	"README.md": "readme",
	"PRIVACY.md": "privacy",
	"SECURITY.md": "security",
};

export async function run(ctx) {
	const out = [];
	const problems = [];
	const missingDocs = [];

	for (const spec of ctx.projectPolicy.requiredDocuments) {
		const text = ctx.docs[DOC_KEY[spec.path]];
		if (text === null || text === undefined) {
			missingDocs.push(spec.path);
			problems.push(finding({ file: spec.path, detail: `${spec.path} is missing`, severity: "high" }));
			continue;
		}
		for (const section of spec.requiredSections) {
			const found = section.anyOf.some(needle => text.toLowerCase().includes(needle.toLowerCase()));
			if (!found) {
				problems.push(finding({
					file: spec.path,
					detail: `no section covering "${section.id}" (expected one of: ${section.anyOf.join(", ")})`,
					severity: "high",
				}));
			}
		}
	}

	out.push(result({
		id: "required-doc-sections",
		title: "README, PRIVACY and SECURITY contain every required disclosure",
		status: problems.length ? STATUS.FAIL : STATUS.PASS,
		severity: "high",
		...ctx.ruleMeta("OBS-OO-013"),
		summary: problems.length
			? `${problems.length} documentation gap(s)${missingDocs.length ? `; missing files: ${missingDocs.join(", ")}` : ""}`
			: "every required section is present in README.md, PRIVACY.md and SECURITY.md",
		findings: problems,
		remediation: "Add the missing sections. The required set is declared in .compliance/ai-vault-policy.json → requiredDocuments.",
	}));

	// ── SECURITY.md must warn about what not to post ────────────────────────
	{
		const security = ctx.docs.security ?? "";
		const warns = /\b(api key|apikey|token|credential)/i.test(security)
			&& /\b(log|note|vault)/i.test(security);

		out.push(result({
			id: "security-policy-warnings",
			title: "SECURITY.md warns against posting keys, notes and full logs in public issues",
			status: !ctx.docs.security ? STATUS.FAIL : warns ? STATUS.PASS : STATUS.FAIL,
			severity: "medium",
			rule: "DOC-SEC-001",
			source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-code",
			summary: !ctx.docs.security
				? "SECURITY.md is missing"
				: warns
					? "the policy warns against posting credentials, private notes and raw logs"
					: "the policy does not warn about posting credentials, private notes or raw logs",
			remediation: "State explicitly that a public issue must never contain an API key, private note content or an unredacted log.",
		}));
	}

	// ── The checks document must exist ──────────────────────────────────────
	out.push(result({
		id: "checks-documentation",
		title: "The security and privacy checks are documented",
		status: ctx.docs.checks ? STATUS.PASS : STATUS.FAIL,
		severity: "low",
		rule: "DOC-CHK-001",
		source: "https://owasp.org/www-project-software-component-verification-standard/",
		summary: ctx.docs.checks
			? "docs/SECURITY-PRIVACY-CHECKS.md describes what runs and how to reproduce it"
			: "docs/SECURITY-PRIVACY-CHECKS.md is missing",
		remediation: "Document every automated check, its rule, and the command that reproduces it locally.",
	}));

	// ── Exceptions must be live and attributed ──────────────────────────────
	{
		const now = new Date();
		const problems = [];
		for (const exception of ctx.projectPolicy.exceptions ?? []) {
			if (!exception.owner) problems.push(`${exception.id} has no owner`);
			if (!exception.justification) problems.push(`${exception.id} has no justification`);
			if (!exception.expiresOn) problems.push(`${exception.id} has no expiry date`);
			else if (new Date(exception.expiresOn) < now) problems.push(`${exception.id} expired on ${exception.expiresOn}`);
		}

		out.push(result({
			id: "policy-exceptions",
			title: "Every policy exception has an owner, a justification and a live expiry",
			status: problems.length ? STATUS.WARNING : STATUS.PASS,
			severity: "medium",
			rule: "DOC-EXC-001",
			source: "https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html",
			summary: problems.length
				? problems.join("; ")
				: `${(ctx.projectPolicy.exceptions ?? []).length} exception(s), all attributed and unexpired`,
			findings: problems.map(p => finding({ file: ".compliance/ai-vault-policy.json", detail: p, severity: "medium" })),
			remediation: "Re-decide the exception or let it lapse; an expired exception stops suppressing its finding.",
		}));
	}

	return out;
}
