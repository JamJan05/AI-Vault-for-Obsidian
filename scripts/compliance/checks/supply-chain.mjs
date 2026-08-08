/**
 * Supply-chain checks: lockfile integrity, dependency sources, install scripts,
 * licences and npm audit.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STATUS, finding, result } from "../lib/model.mjs";

const execFileAsync = promisify(execFile);

async function npmJson(args, cwd) {
	try {
		const { stdout } = await execFileAsync("npm", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
		return { ok: true, data: JSON.parse(stdout) };
	} catch (error) {
		// `npm audit` exits non-zero when it finds vulnerabilities, but still prints
		// valid JSON on stdout — that is a result, not a failure to run.
		if (error?.stdout) {
			try {
				return { ok: true, data: JSON.parse(error.stdout) };
			} catch {
				// fall through
			}
		}
		return { ok: false, error: error?.message ?? String(error) };
	}
}

export async function run(ctx) {
	const out = [];
	const meta = id => ctx.ruleMeta(id);
	const policy = ctx.projectPolicy;

	// ── Lockfile ────────────────────────────────────────────────────────────
	{
		const problems = [];
		if (!ctx.lock) {
			problems.push("package-lock.json is missing");
		} else {
			if (ctx.trackedFiles && !ctx.trackedFiles.includes("package-lock.json")) {
				problems.push("package-lock.json is not tracked by git");
			}
			if (ctx.lock.lockfileVersion < 2) {
				problems.push(`lockfileVersion ${ctx.lock.lockfileVersion} does not record integrity hashes for the whole tree`);
			}
			if (ctx.lock.version !== ctx.pkg.version) {
				problems.push(`package-lock.json version ${ctx.lock.version} differs from package.json ${ctx.pkg.version}`);
			}

			const allowedRegistries = policy.supplyChain.allowedRegistries;
			let missingIntegrity = 0;
			let foreignRegistry = 0;
			for (const [name, entry] of Object.entries(ctx.lock.packages ?? {})) {
				if (!name || entry.link) continue;
				if (entry.resolved) {
					if (!allowedRegistries.some(registry => entry.resolved.startsWith(registry))) {
						foreignRegistry += 1;
						problems.push(`${name} resolves to ${entry.resolved}`);
					}
					if (!entry.integrity) missingIntegrity += 1;
				}
			}
			if (missingIntegrity) problems.push(`${missingIntegrity} package(s) have no integrity hash`);
			if (foreignRegistry) problems.push(`${foreignRegistry} package(s) come from outside the allowed registry`);
		}

		out.push(result({
			id: "lockfile-integrity",
			title: "The lockfile is committed, complete and pinned to the public registry",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			...meta("OBS-OO-003"),
			summary: problems.length
				? problems.slice(0, 5).join("; ")
				: `lockfileVersion ${ctx.lock.lockfileVersion}, ${Object.keys(ctx.lock.packages ?? {}).length} entries, all pinned with integrity hashes`,
			findings: problems.map(p => finding({ file: "package-lock.json", detail: p, severity: "high" })),
			remediation: "Commit package-lock.json, run `npm install` to regenerate it after editing package.json, and keep every dependency on the public npm registry.",
		}));
	}

	// ── Dependency specifiers ───────────────────────────────────────────────
	{
		const forbidden = policy.supplyChain.forbidDependencySpecifiers;
		const problems = [];
		for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
			for (const [name, spec] of Object.entries(ctx.pkg[field] ?? {})) {
				if (forbidden.some(prefix => String(spec).startsWith(prefix))) {
					problems.push(finding({ file: "package.json", detail: `${field}.${name} uses a non-registry specifier "${spec}"`, severity: "high" }));
				}
			}
		}

		out.push(result({
			id: "dependency-specifiers",
			title: "No dependency is installed from a URL, git or a local path",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			rule: "SC-DEP-001",
			source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-code",
			summary: problems.length ? `${problems.length} non-registry specifier(s)` : "every dependency is a registry version range",
			findings: problems,
			remediation: "Replace git/URL/file specifiers with published registry versions so the lockfile can pin an integrity hash.",
		}));
	}

	// ── Install scripts ─────────────────────────────────────────────────────
	{
		const withScripts = [];
		for (const [name, entry] of Object.entries(ctx.lock?.packages ?? {})) {
			if (!name) continue;
			if (entry.hasInstallScript) withScripts.push(name.replace(/^node_modules\//, ""));
		}
		const accepted = new Set(policy.supplyChain.installScripts.accepted);
		const unexpected = withScripts.filter(name => !accepted.has(name.split("/").pop()) && !accepted.has(name));

		out.push(result({
			id: "install-scripts",
			title: "Packages with install scripts are known and accepted",
			status: unexpected.length ? STATUS.WARNING : STATUS.PASS,
			severity: "medium",
			rule: "SC-DEP-002",
			source: "https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html",
			summary: withScripts.length
				? `install scripts: ${withScripts.join(", ")}${unexpected.length ? ` — unexpected: ${unexpected.join(", ")}` : " — all accepted"}`
				: "no package in the tree declares an install script",
			findings: unexpected.map(name => finding({ file: "package-lock.json", detail: `unexpected install script in ${name}`, severity: "medium" })),
			remediation: "Install with --ignore-scripts where possible and add any genuinely required script to .compliance/ai-vault-policy.json → supplyChain.installScripts.accepted with a reason.",
		}));
	}

	// ── npm audit ───────────────────────────────────────────────────────────
	{
		const audit = await npmJson(["audit", "--json"], ctx.root);
		if (!audit.ok) {
			out.push(result({
				id: "npm-audit",
				title: "npm audit finds no high or critical vulnerability",
				status: STATUS.BLOCKED,
				reason: `npm audit could not be run: ${ctx.redaction.sanitizeErrorDetail(audit.error)}. This usually means no network access to the advisory database.`,
				rule: "SC-VULN-001",
				source: "https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference",
				summary: "The advisory database could not be reached, so no conclusion can be drawn.",
				remediation: "Re-run `npm audit --json` with network access. A blocked audit is not a pass.",
				blocksRelease: true,
			}));
		} else {
			const meta = audit.data.metadata?.vulnerabilities ?? {};
			const blocking = policy.vulnerabilityThresholds.npmAudit.blockingSeverities;
			const vulns = Object.entries(audit.data.vulnerabilities ?? {});
			const blockingVulns = [];
			const excepted = [];

			for (const [name, vuln] of vulns) {
				if (!blocking.includes(vuln.severity)) continue;
				const exception = ctx.activeException("npmAudit", name);
				if (exception) excepted.push({ name, vuln, exception });
				else blockingVulns.push({ name, vuln });
			}

			const titles = vuln => (vuln.via ?? [])
				.map(v => (typeof v === "string" ? v : v.title))
				.filter(Boolean)
				.slice(0, 2)
				.join(" | ");

			out.push(result({
				id: "npm-audit",
				title: "npm audit finds no high or critical vulnerability",
				status: blockingVulns.length ? STATUS.FAIL : STATUS.PASS,
				severity: blockingVulns.some(v => v.vuln.severity === "critical") ? "critical" : "high",
				rule: "SC-VULN-001",
				source: "https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference",
				summary: `critical=${meta.critical ?? 0} high=${meta.high ?? 0} moderate=${meta.moderate ?? 0} low=${meta.low ?? 0}` +
					(excepted.length ? `; ${excepted.length} covered by a documented exception` : ""),
				findings: blockingVulns.map(({ name, vuln }) => finding({
					file: "package-lock.json",
					detail: `${name} (${vuln.severity}): ${titles(vuln)}`,
					severity: vuln.severity,
				})),
				remediation: "Run `npm audit fix`. If a fix requires a breaking change, record a time-boxed exception in .compliance/ai-vault-policy.json with an owner and a technical justification.",
			}));

			// Moderate and low findings are reported so they are visible, without
			// blocking — the threshold is declared in the policy file, not here.
			const belowThreshold = vulns.filter(([, v]) => !blocking.includes(v.severity));
			// An exception may also cover a below-threshold finding; showing it here
			// makes the documented decision visible instead of silently absent.
			const belowThresholdExceptions = belowThreshold
				.map(([name]) => ({ name, exception: ctx.activeException("npmAudit", name) }))
				.filter(entry => entry.exception);
			if (belowThreshold.length || excepted.length) {
				out.push(result({
					id: "npm-audit-below-threshold",
					title: "Vulnerabilities below the blocking threshold",
					status: STATUS.WARNING,
					severity: "medium",
					rule: "SC-VULN-002",
					source: "https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference",
					summary: `${belowThreshold.length} below threshold, ${excepted.length + belowThresholdExceptions.length} under an active exception`,
					findings: [
						...belowThreshold.map(([name, v]) => finding({ file: "package-lock.json", detail: `${name} (${v.severity}): ${titles(v)}`, severity: v.severity })),
						...excepted.map(({ name, vuln, exception }) => finding({
							file: ".compliance/ai-vault-policy.json",
							detail: `${name} (${vuln.severity}) accepted under ${exception.id}, expires ${exception.expiresOn}`,
							severity: vuln.severity,
						})),
						...belowThresholdExceptions.map(({ name, exception }) => finding({
							file: ".compliance/ai-vault-policy.json",
							detail: `${name} has a documented decision: ${exception.id}, expires ${exception.expiresOn}`,
							severity: "low",
						})),
					],
					remediation: "Track these; they do not block a release under the declared threshold.",
				}));
			}
		}
	}

	// ── Licences ────────────────────────────────────────────────────────────
	{
		// Read from the lockfile, not from `npm ls`. The lockfile records a license
		// for every entry in the tree; `npm ls` only sees what is installed on this
		// machine, so the twenty optional @esbuild platform packages come back as
		// UNKNOWN on any single OS even though the lockfile says MIT.
		const entries = Object.entries(ctx.lock?.packages ?? {}).filter(([name]) => name);
		if (!entries.length) {
			out.push(result({
				id: "license-inventory",
				title: "Every dependency licence is on the allow list",
				status: STATUS.BLOCKED,
				reason: "package-lock.json has no package entries, so the dependency tree could not be enumerated.",
				...meta("OBS-POL-014"),
				summary: "No licence conclusion could be drawn.",
				remediation: "Regenerate the lockfile with `npm install`.",
				blocksRelease: false,
			}));
		} else {
			const allowed = new Set(policy.licensePolicy.allowedDependencyLicenses);
			const denied = new Set(policy.licensePolicy.deniedDependencyLicenses);
			const review = new Set(policy.licensePolicy.reviewRequiredLicenses);

			const violations = [];
			const needsReview = [];
			const unknown = [];
			const counts = new Map();

			for (const [key, entry] of entries) {
				if (entry.link) continue;
				const name = entry.name ?? key.replace(/^node_modules\//, "").replace(/.*\/node_modules\//, "");
				const license = entry.license;

				if (!license) {
					unknown.push({ name, license: "not declared in the lockfile" });
					continue;
				}

				const text = typeof license === "string" ? license : JSON.stringify(license);
				counts.set(text, (counts.get(text) ?? 0) + 1);

				// SPDX expressions such as "(MIT OR CC0-1.0)" pass when every
				// alternative is allowed.
				const parts = text.replace(/[()]/g, "").split(/\s+(?:OR|AND)\s+/i).map(x => x.trim()).filter(Boolean);
				if (parts.some(x => denied.has(x))) violations.push({ name, license: text });
				else if (parts.some(x => review.has(x))) needsReview.push({ name, license: text });
				else if (!parts.every(x => allowed.has(x))) needsReview.push({ name, license: text });
			}

			const summaryOfLicences = [...counts.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([license, count]) => `${license}×${count}`)
				.join(", ");

			out.push(result({
				id: "license-inventory",
				title: "Every dependency licence is on the allow list",
				status: violations.length ? STATUS.FAIL
					: (needsReview.length || unknown.length) ? STATUS.MANUAL_REVIEW
						: STATUS.PASS,
				severity: "medium",
				reason: violations.length ? undefined
					: (needsReview.length || unknown.length)
						? `${needsReview.length} package(s) use a licence that is neither explicitly allowed nor denied, and ${unknown.length} declare none — a human must confirm the obligations.`
						: undefined,
				...meta("OBS-POL-014"),
				summary: violations.length || needsReview.length || unknown.length
					? `${entries.length} package(s); ${violations.length} denied, ${needsReview.length} needing review, ${unknown.length} undeclared`
					: `${entries.length} package(s), all on the allow list: ${summaryOfLicences}`,
				findings: [
					...violations.map(v => finding({ file: "package-lock.json", detail: `${v.name}: ${v.license} is on the deny list`, severity: "high" })),
					...needsReview.slice(0, 20).map(v => finding({ file: "package-lock.json", detail: `${v.name}: ${v.license}`, severity: "low" })),
					...unknown.slice(0, 20).map(v => finding({ file: "package-lock.json", detail: `${v.name}: ${v.license}`, severity: "low" })),
				],
				remediation: "Replace a denied dependency, or add the licence to allowedDependencyLicenses in .compliance/ai-vault-policy.json after confirming its obligations.",
			}));
		}
	}

	// ── Project licence file ────────────────────────────────────────────────
	{
		const problems = [];
		if (!ctx.docs.license) problems.push("LICENSE is missing");
		if (!ctx.pkg.license) problems.push("package.json has no license field");
		if (ctx.docs.readme && !/licen[cs]e/i.test(ctx.docs.readme)) problems.push("the README does not state the licence");

		out.push(result({
			id: "license-present",
			title: "A LICENSE file exists and the licence is stated",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "medium",
			...meta("OBS-POL-013"),
			summary: problems.length ? problems.join("; ") : `${ctx.pkg.license}, LICENSE present and referenced from the README`,
			findings: problems.map(p => finding({ file: "LICENSE", detail: p, severity: "medium" })),
			remediation: "Add a LICENSE file, set the license field in package.json and mention it in the README.",
		}));
	}

	// ── Source availability ─────────────────────────────────────────────────
	{
		const runtimeDeps = Object.keys(ctx.pkg.dependencies ?? {});
		const problems = [];
		if (runtimeDeps.length) {
			problems.push(`${runtimeDeps.length} runtime dependency/ies are bundled into main.js: ${runtimeDeps.join(", ")}`);
		}
		const committedBinaries = (ctx.trackedFiles ?? []).filter(f => /\.(min\.js|wasm|node|exe|dll|so|dylib)$/.test(f));
		for (const file of committedBinaries) {
			problems.push(`binary or pre-minified file committed: ${file}`);
		}

		out.push(result({
			id: "source-availability",
			title: "Everything bundled into the release is present as readable source",
			status: committedBinaries.length ? STATUS.FAIL : STATUS.PASS,
			severity: "medium",
			...meta("OBS-POL-012"),
			summary: problems.length
				? problems.join("; ")
				: `no runtime dependencies and no committed binaries; the bundle is built only from src/`,
			findings: committedBinaries.map(f => finding({ file: f, detail: "committed binary or pre-minified artefact", severity: "medium" })),
			remediation: "Ship source, not binaries. Anything bundled must be reproducible from the repository.",
		}));
	}

	return out;
}
