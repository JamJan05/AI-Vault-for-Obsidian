/**
 * Network, telemetry and disclosure checks.
 *
 * The core idea: build the network endpoint inventory from the code, then require
 * that the documentation and the code agree in BOTH directions. An endpoint in the
 * code that the docs do not mention is undisclosed network use; a service named in
 * the docs that the code never contacts is a misleading disclosure.
 */

import { stripComments } from "../lib/context.mjs";
import { STATUS, finding, result } from "../lib/model.mjs";

const URL_LITERAL = /["'`](https?:\/\/[^"'`\s${}]+)["'`]/g;

/** Hosts that appear in comments, docs links or default settings rather than as call targets. */
function extractHosts(text) {
	const hosts = new Map();
	let match;
	URL_LITERAL.lastIndex = 0;
	while ((match = URL_LITERAL.exec(text)) !== null) {
		try {
			const url = new URL(match[1]);
			const existing = hosts.get(url.hostname) ?? [];
			existing.push(match[1]);
			hosts.set(url.hostname, existing);
		} catch {
			// A malformed literal is not an endpoint.
		}
	}
	return hosts;
}

export async function run(ctx) {
	const out = [];
	const meta = id => ctx.ruleMeta(id);
	const policy = ctx.projectPolicy.network;
	const allowedHosts = new Set(policy.allowedHosts.map(h => h.host));
	const loopbackDefaults = new Set(
		policy.userConfiguredHost.defaults.map(u => {
			try { return new URL(u).hostname; } catch { return u; }
		}),
	);

	// ── Endpoint inventory ──────────────────────────────────────────────────
	const inventory = new Map();
	for (const file of ctx.sources.values()) {
		file.lines.forEach((line, index) => {
			for (const [host, urls] of extractHosts(stripComments(line))) {
				const entry = inventory.get(host) ?? { host, urls: new Set(), locations: [] };
				urls.forEach(u => entry.urls.add(u));
				entry.locations.push({ file: file.rel, line: index + 1, evidence: line.trim() });
				inventory.set(host, entry);
			}
		});
	}

	const undeclared = [...inventory.values()].filter(entry =>
		!allowedHosts.has(entry.host) && !loopbackDefaults.has(entry.host),
	);

	out.push(result({
		id: "network-endpoint-inventory",
		title: "Every network endpoint in the source is a declared one",
		status: undeclared.length ? STATUS.FAIL : STATUS.PASS,
		severity: "critical",
		...meta("OBS-POL-002"),
		summary: undeclared.length
			? `${undeclared.length} undeclared host(s): ${undeclared.map(e => e.host).join(", ")}`
			: `hosts in source: ${[...inventory.keys()].sort().join(", ") || "none"} — all declared`,
		findings: undeclared.flatMap(entry =>
			entry.locations.map(loc => finding({ ...loc, detail: `undeclared host ${entry.host}`, severity: "critical" })),
		),
		remediation: "Either remove the endpoint or add it to .compliance/ai-vault-policy.json → network.allowedHosts and disclose it in README.md and PRIVACY.md.",
	}));

	// ── Telemetry ───────────────────────────────────────────────────────────
	{
		const findings = [];

		for (const host of policy.forbiddenIndicators.hosts) {
			for (const hit of ctx.grepSources(new RegExp(host.replace(/\./g, "\\."), "i"))) {
				findings.push(finding({ ...hit, detail: `analytics host "${host}"`, severity: "critical" }));
			}
		}

		const deps = {
			...(ctx.pkg.dependencies ?? {}),
			...(ctx.pkg.devDependencies ?? {}),
			...(ctx.pkg.optionalDependencies ?? {}),
		};
		for (const name of policy.forbiddenIndicators.packages) {
			if (deps[name]) {
				findings.push(finding({ file: "package.json", detail: `analytics package "${name}" is a dependency`, severity: "critical" }));
			}
			if (ctx.lock?.packages?.[`node_modules/${name}`]) {
				findings.push(finding({ file: "package-lock.json", detail: `analytics package "${name}" is in the dependency tree`, severity: "high" }));
			}
		}

		// Identifier patterns are a weaker signal, so they are reported separately
		// below rather than folded into the hard failure.
		const identifierHits = [];
		for (const pattern of policy.forbiddenIndicators.identifierPatterns) {
			for (const hit of ctx.grepSources(new RegExp(`\\b${pattern}\\b`))) {
				identifierHits.push(finding({ ...hit, detail: `identifier "${pattern}"`, severity: "medium" }));
			}
		}

		out.push(result({
			id: "no-telemetry",
			title: "No client-side telemetry or analytics",
			status: findings.length ? STATUS.FAIL : STATUS.PASS,
			severity: "critical",
			...meta("OBS-POL-004"),
			summary: findings.length
				? `${findings.length} telemetry indicator(s)`
				: `no analytics hosts or SDKs in source, dependencies or lockfile${identifierHits.length ? `; ${identifierHits.length} identifier-shaped name(s) reviewed and cleared` : ""}`,
			findings: findings.length ? findings : identifierHits.slice(0, 10),
			remediation: "Remove the analytics SDK or endpoint. Obsidian forbids client-side telemetry outright, and user consent does not make it allowed.",
		}));
	}

	// ── First-party backend ─────────────────────────────────────────────────
	{
		const firstParty = [...inventory.values()].filter(entry =>
			!allowedHosts.has(entry.host) && !loopbackDefaults.has(entry.host) && !/^(docs|github|www)\./.test(entry.host),
		);
		const privacyStates = ctx.docs.privacy
			? /no (?:first-party |own )?(?:backend|server)|does not (?:use|run|operate) (?:its own|any) (?:backend|server)/i.test(ctx.docs.privacy)
			: false;

		out.push(result({
			id: "no-first-party-backend",
			title: "The plugin operates no backend of its own",
			status: firstParty.length ? STATUS.FAIL : privacyStates ? STATUS.PASS : STATUS.WARNING,
			severity: firstParty.length ? "critical" : "medium",
			...meta("OBS-POL-011"),
			summary: firstParty.length
				? `possible first-party endpoint(s): ${firstParty.map(e => e.host).join(", ")}`
				: privacyStates
					? "no first-party endpoint in source, and PRIVACY.md says so explicitly"
					: "no first-party endpoint in source, but PRIVACY.md does not state it explicitly",
			findings: firstParty.flatMap(e => e.locations.map(loc => finding({ ...loc, detail: `possible first-party backend ${e.host}`, severity: "critical" }))),
			remediation: "State in PRIVACY.md that the plugin runs no server of its own and that requests go directly from Obsidian to the chosen provider.",
		}));
	}

	// ── Disclosure cross-check ──────────────────────────────────────────────
	{
		const docsText = `${ctx.docs.readme ?? ""}\n${ctx.docs.privacy ?? ""}`;
		const missingFromDocs = [];
		for (const declared of policy.allowedHosts) {
			// Either the exact host or the human name of the service must be present.
			const mentioned = docsText.includes(declared.host)
				|| new RegExp(declared.host.split(".").slice(-2, -1)[0], "i").test(docsText);
			if (!mentioned) missingFromDocs.push(declared.host);
		}

		const contactedHosts = new Set([...inventory.keys()].filter(h => allowedHosts.has(h)));
		const documentedButUnused = policy.allowedHosts
			.map(h => h.host)
			.filter(h => docsText.includes(h) && !contactedHosts.has(h));

		const problems = [
			...missingFromDocs.map(h => `${h} is contacted but not named in README.md/PRIVACY.md`),
			...documentedButUnused.map(h => `${h} is documented but never contacted from src/`),
		];

		out.push(result({
			id: "disclosure-network",
			title: "Documentation and code agree about network use",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "critical",
			...meta("OBS-POL-008"),
			summary: problems.length ? problems.join("; ") : `${contactedHosts.size} declared host(s) documented in both directions`,
			findings: problems.map(p => finding({ file: "README.md", detail: p, severity: "critical" })),
			remediation: "Obsidian requires the README to clearly explain which remote services are used and why. Update README.md and PRIVACY.md so they match the code exactly.",
		}));
	}

	// ── External file access disclosure ─────────────────────────────────────
	{
		const writesOutsideVault = ctx.grepSources(/from\s+["'](?:node:)?fs(?:\/promises)?["']/).length > 0;
		const docsText = `${ctx.docs.readme ?? ""}\n${ctx.docs.privacy ?? ""}`;
		const disclosed = /outside (?:your |the )?vault|next to the vault|outside of (?:your |the )?vault/i.test(docsText);

		out.push(result({
			id: "disclosure-external-files",
			title: "Access to files outside the vault is disclosed",
			status: !writesOutsideVault ? STATUS.NOT_APPLICABLE : disclosed ? STATUS.PASS : STATUS.FAIL,
			severity: "high",
			reason: writesOutsideVault ? undefined : "The plugin does not touch the file system outside the vault.",
			...meta("OBS-POL-009"),
			summary: writesOutsideVault
				? (disclosed ? "README/PRIVACY explain the storage directory outside the vault" : "the plugin writes outside the vault but the docs do not say so")
				: "no file-system access outside the vault",
			remediation: "Obsidian requires the README to clearly explain why files outside the vault are accessed. Name the default directory and the reason.",
		}));
	}

	// ── Accounts and costs disclosure ───────────────────────────────────────
	{
		const docsText = `${ctx.docs.readme ?? ""}\n${ctx.docs.privacy ?? ""}`;
		const problems = [];
		if (!/API key/i.test(docsText)) problems.push("the docs do not mention that an API key is required");
		if (!/(cost|billing|billed|paid|charge|pricing)/i.test(docsText)) {
			problems.push("the docs do not mention that provider API usage may cost money");
		}
		if (!/(account)/i.test(docsText)) problems.push("the docs do not mention that a provider account is required");

		out.push(result({
			id: "disclosure-costs",
			title: "Required accounts, keys and possible costs are disclosed",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "medium",
			...meta("OBS-POL-006"),
			summary: problems.length ? problems.join("; ") : "accounts, keys and cost implications are documented",
			findings: problems.map(p => finding({ file: "README.md", detail: p, severity: "medium" })),
			remediation: "State in the README that an OpenAI and/or Anthropic account and API key are required and that usage is billed by the provider.",
		}));
	}

	// ── Prompt injection ────────────────────────────────────────────────────
	out.push(result({
		id: "prompt-injection-risk",
		title: "Prompt injection through note content and model output",
		status: STATUS.MANUAL_REVIEW,
		severity: "medium",
		reason: "Note text, canvas content and model replies are all untrusted input that reaches a prompt or the rendered view. This is an application-level risk that no static check can settle, and it cannot be solved with a pattern match.",
		...meta("OBS-SEC-001"),
		summary: "Inherent to a retrieval-augmented assistant: retrieved note text can carry instructions aimed at the model.",
		remediation: "Keep the mitigations that exist (model output is rendered, never executed; no eval; no shell; no automatic file writes from a reply) and document the residual risk in PRIVACY.md.",
	}));

	return out;
}
