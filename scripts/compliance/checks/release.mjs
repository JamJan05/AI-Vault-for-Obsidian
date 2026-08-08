/**
 * Release integrity: version consistency, release assets, attestation coverage,
 * bundle inspection and documentation completeness.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { STATUS, finding, result } from "../lib/model.mjs";

export async function run(ctx) {
	const out = [];
	const meta = id => ctx.ruleMeta(id);

	// ── Version consistency ─────────────────────────────────────────────────
	{
		const version = ctx.manifest.version;
		const problems = [];
		if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
			problems.push(`manifest version "${version}" is not stable semver`);
		}
		if (ctx.pkg.version !== version) {
			problems.push(`package.json is ${ctx.pkg.version}, manifest.json is ${version}`);
		}
		if (ctx.lock && ctx.lock.version !== version) {
			problems.push(`package-lock.json is ${ctx.lock.version}, manifest.json is ${version}`);
		}
		if (ctx.versions && !(version in ctx.versions)) {
			problems.push(`versions.json has no entry for ${version}`);
		}
		const tagExists = ctx.tags ? ctx.tags.includes(String(version)) : null;
		if (tagExists === false) {
			problems.push(`no git tag "${version}" exists locally, so the manifest points at a version that was never released`);
		}

		out.push(result({
			id: "version-consistency",
			title: "manifest, package, lockfile, versions.json and the git tag agree",
			status: problems.length ? STATUS.FAIL : tagExists === null ? STATUS.MANUAL_REVIEW : STATUS.PASS,
			severity: "high",
			reason: tagExists === null && !problems.length
				? "Git tags could not be listed, so the tag half of the check could not run."
				: undefined,
			...meta("OBS-REL-003"),
			summary: problems.length
				? problems.join("; ")
				: `version ${version} is consistent across all files${tagExists ? " and has a matching tag" : ""}`,
			findings: problems.map(p => finding({ file: "manifest.json", detail: p, severity: "high" })),
			remediation: "Let the release workflow set the version from the tag; do not bump it by hand.",
		}));
	}

	// ── Release assets ──────────────────────────────────────────────────────
	{
		const releaseWorkflow = [...ctx.workflows.values()].find(w => /release/i.test(w.rel));
		const required = ["main.js", "manifest.json"];
		const hasStyles = existsSync(join(ctx.root, "styles.css"));
		if (hasStyles) required.push("styles.css");

		const problems = [];
		if (!releaseWorkflow) {
			problems.push("no release workflow was found");
		} else {
			const uploadSection = releaseWorkflow.text;
			for (const asset of required) {
				if (!uploadSection.includes(asset)) problems.push(`the release workflow never uploads ${asset}`);
			}
		}
		if (!ctx.bundle) problems.push("main.js does not exist in the working tree; run npm run build");

		out.push(result({
			id: "release-assets",
			title: "The release publishes main.js, manifest.json and styles.css",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			...meta("OBS-REL-001"),
			summary: problems.length ? problems.join("; ") : `all ${required.length} required asset(s) are uploaded`,
			findings: problems.map(p => finding({ file: releaseWorkflow?.rel ?? ".github/workflows/release.yml", detail: p, severity: "high" })),
			remediation: "Upload main.js, manifest.json and styles.css as release assets.",
		}));
	}

	// ── Attestation coverage ────────────────────────────────────────────────
	{
		const releaseWorkflow = [...ctx.workflows.values()].find(w => /release/i.test(w.rel));
		if (!releaseWorkflow) {
			out.push(result({
				id: "attestation-coverage",
				title: "Build provenance covers every published artefact",
				status: STATUS.MANUAL_REVIEW,
				reason: "No release workflow was found, so attestation coverage cannot be derived.",
				...meta("OBS-REL-002"),
				summary: "Nothing to inspect.",
			}));
		} else {
			const attestBlock = /attest[^\n]*\n(?:[\s\S]*?)subject-path:\s*\|([\s\S]*?)(?:\n\s*-\s|\n\s{0,6}[a-z-]+:|\n\n)/i.exec(releaseWorkflow.text);
			const attested = attestBlock
				? attestBlock[1].split("\n").map(s => s.trim()).filter(Boolean)
				: [];
			const uploaded = ["main.js", "manifest.json"];
			if (existsSync(join(ctx.root, "styles.css"))) uploaded.push("styles.css");
			const missing = uploaded.filter(asset => !attested.includes(asset));

			out.push(result({
				id: "attestation-coverage",
				title: "Build provenance covers every published artefact",
				status: attested.length === 0 ? STATUS.FAIL : missing.length ? STATUS.FAIL : STATUS.PASS,
				severity: "medium",
				...meta("OBS-REL-002"),
				summary: attested.length === 0
					? "no attestation step was found in the release workflow"
					: missing.length
						? `attested: ${attested.join(", ")}; published but not attested: ${missing.join(", ")}`
						: `all ${attested.length} published artefact(s) are attested`,
				findings: missing.map(asset => finding({
					file: releaseWorkflow.rel,
					detail: `${asset} is published as a release asset but is not covered by the build provenance attestation`,
					severity: "medium",
				})),
				remediation: "Add every uploaded asset to the attestation action's subject-path so a consumer can verify all of them.",
			}));
		}
	}

	// ── main.js not committed ───────────────────────────────────────────────
	{
		const ignored = /^main\.js$/m.test(ctx.docs.gitignore);
		const tracked = (ctx.trackedFiles ?? []).includes("main.js");
		const problems = [];
		if (tracked) problems.push("main.js is tracked by git");
		if (!ignored) problems.push("main.js is not listed in .gitignore");

		out.push(result({
			id: "main-js-not-committed",
			title: "main.js is a build output, not a committed file",
			status: tracked ? STATUS.FAIL : problems.length ? STATUS.WARNING : STATUS.PASS,
			severity: "low",
			...meta("OBS-OO-001"),
			summary: problems.length ? problems.join("; ") : "main.js is git-ignored and untracked",
			findings: problems.map(p => finding({ file: ".gitignore", detail: p, severity: "low" })),
			remediation: "Keep main.js out of the repository and ship it only as a release asset.",
		}));
	}

	// ── Bundle inspection ───────────────────────────────────────────────────
	{
		if (!ctx.bundle) {
			out.push(result({
				id: "bundle-inspection",
				title: "The built bundle contains nothing that is not in the source",
				status: STATUS.BLOCKED,
				reason: "main.js does not exist. Run `npm run build` before the compliance run.",
				rule: "REL-BUNDLE-001",
				source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-builds",
				summary: "No bundle to inspect.",
				remediation: "Build first, then re-run.",
				blocksRelease: true,
			}));
		} else {
			const policy = ctx.projectPolicy.bundlePolicy;
			const problems = [];

			// Hosts in the bundle must be a subset of the hosts declared for it.
			const hostPattern = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
			const bundleHosts = new Set();
			let match;
			while ((match = hostPattern.exec(ctx.bundle)) !== null) bundleHosts.add(match[1].toLowerCase());
			const allowed = new Set(policy.allowedExternalHostsInBundle);
			// Documentation links inside comments are stripped by minification, but a
			// non-minified dev build may still carry them.
			const docHosts = new Set(["docs.obsidian.md", "github.com", "obsidian.md", "developer.mozilla.org"]);
			const unexpectedHosts = [...bundleHosts].filter(h => !allowed.has(h) && !docHosts.has(h));
			for (const host of unexpectedHosts) {
				problems.push(finding({ file: "main.js", detail: `bundle references undeclared host ${host}`, severity: "critical" }));
			}

			for (const forbidden of policy.forbiddenInBundle) {
				if (ctx.bundle.includes(forbidden)) {
					problems.push(finding({ file: "main.js", detail: `bundle contains "${forbidden}"`, severity: "high" }));
				}
			}

			out.push(result({
				id: "bundle-inspection",
				title: "The built bundle contains nothing that is not in the source",
				status: problems.length ? STATUS.FAIL : STATUS.PASS,
				severity: "critical",
				rule: "REL-BUNDLE-001",
				source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-builds",
				summary: problems.length
					? `${problems.length} unexpected item(s) in main.js`
					: `bundle hosts: ${[...bundleHosts].sort().join(", ") || "none"} — all declared`,
				findings: problems,
				remediation: "Every endpoint and capability in the bundle must have a counterpart in src/ and a disclosure in the README.",
			}));
		}
	}

	// ── Reproducibility ─────────────────────────────────────────────────────
	{
		// The record is evidence of a past verification, not a substitute for one.
		// It is cited so the report shows when the check was last actually done.
		let record = null;
		try {
			record = JSON.parse(await readFile(join(ctx.root, ".compliance", "reproducibility.json"), "utf8"));
		} catch {
			record = null;
		}

		const latest = record?.verifications?.[record.verifications.length - 1] ?? null;
		const mismatched = latest
			? Object.entries(latest.artifacts ?? {}).filter(([, info]) => info.match !== "exact")
			: [];

		out.push(result({
			id: "release-reproducibility",
			title: "A clean build reproduces the published release artefact",
			status: mismatched.length ? STATUS.FAIL : STATUS.MANUAL_REVIEW,
			severity: "high",
			reason: mismatched.length ? undefined : latest
				? `Verifying a published artefact needs network access and a chosen tag, so this cannot run inside the offline compliance sweep. Last recorded verification: tag ${latest.tag} on ${latest.verifiedOn} — ${latest.result} Re-run it before the next release.`
				: "No verification has been recorded in .compliance/reproducibility.json, and comparing against a published release needs network access and a chosen tag.",
			rule: "REL-REPRO-001",
			source: "https://docs.github.com/en/code-security/tutorials/implement-supply-chain-best-practices/securing-builds",
			summary: latest
				? `Last verified: ${latest.tag} on ${latest.verifiedOn}, ${Object.keys(latest.artifacts ?? {}).length} artefact(s), ${mismatched.length ? `${mismatched.length} mismatch(es)` : "all exact"}`
				: "Never verified.",
			findings: mismatched.map(([name, info]) => finding({
				file: name,
				detail: `published ${name} does not match a clean build (${info.match})`,
				severity: "high",
			})),
			remediation: "git worktree add /tmp/repro <tag> && cd /tmp/repro && npm ci && npm run build && sha256sum main.js, then compare with the published asset and record the result in .compliance/reproducibility.json.",
		}));
	}

	return out;
}
