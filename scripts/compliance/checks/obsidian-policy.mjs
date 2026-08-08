/**
 * Checks derived from the Obsidian Developer policies, the Submission
 * requirements and the Plugin guidelines. Rule ids and source URLs come from
 * .compliance/obsidian-policy-map.json.
 */

import { STATUS, finding, result } from "../lib/model.mjs";

const NODE_BUILTINS = /^(?:node:)?(fs|fs\/promises|path|os|crypto|child_process|http|https|net|dgram|worker_threads|electron)$/;

export async function run(ctx) {
	const out = [];
	const meta = id => ctx.ruleMeta(id);

	// ── OBS-SUB-003: description ────────────────────────────────────────────
	{
		const description = String(ctx.manifest.description ?? "");
		const problems = [];
		if (!description) problems.push("manifest.json has no description");
		if (description.length > 250) problems.push(`description is ${description.length} characters (max 250)`);
		if (description && !description.trimEnd().endsWith(".")) problems.push("description does not end with a period");
		if (/^this is a plugin/i.test(description)) problems.push('description starts with "This is a plugin"');
		// "Avoid using emoji or special characters."
		const emoji = description.match(/\p{Extended_Pictographic}/gu) ?? [];
		if (emoji.length) problems.push(`description contains emoji: ${emoji.join(" ")}`);
		const exotic = description.match(/[—–]/g) ?? [];
		if (exotic.length) problems.push(`description contains typographic dashes (${exotic.join(" ")}); a plain hyphen is safer`);

		out.push(result({
			id: "manifest-description",
			title: "Plugin description follows the submission requirements",
			status: problems.length ? STATUS.WARNING : STATUS.PASS,
			severity: "low",
			...meta("OBS-SUB-003"),
			summary: problems.length ? problems.join("; ") : `description is ${description.length} characters and well formed`,
			findings: problems.map(p => finding({ file: "manifest.json", detail: p, severity: "low" })),
			remediation: "Edit manifest.json: keep the description under 250 characters, end it with a period and avoid emoji and typographic dashes.",
		}));
	}

	// ── OBS-SUB-002: minAppVersion ──────────────────────────────────────────
	{
		const minAppVersion = ctx.manifest.minAppVersion;
		const problems = [];
		if (!minAppVersion) problems.push("manifest.json has no minAppVersion");
		else if (!/^\d+\.\d+\.\d+$/.test(String(minAppVersion))) problems.push(`minAppVersion "${minAppVersion}" is not x.y.z`);
		if (ctx.versions && ctx.versions[ctx.manifest.version] !== minAppVersion) {
			problems.push(`versions.json maps ${ctx.manifest.version} to ${ctx.versions[ctx.manifest.version] ?? "nothing"}, manifest says ${minAppVersion}`);
		}

		out.push(result({
			id: "manifest-min-app-version",
			title: "minAppVersion is declared and consistent with versions.json",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "medium",
			...meta("OBS-SUB-002"),
			summary: problems.length ? problems.join("; ") : `minAppVersion ${minAppVersion} matches versions.json`,
			findings: problems.map(p => finding({ file: "manifest.json", detail: p, severity: "medium" })),
			remediation: "Set minAppVersion in manifest.json and add the matching entry to versions.json.",
		}));
	}

	// ── OBS-SUB-004: isDesktopOnly ──────────────────────────────────────────
	{
		const nodeImports = [];
		for (const file of ctx.sources.values()) {
			file.lines.forEach((line, index) => {
				const match = /^\s*import\s+[^;]*?from\s+["']([^"']+)["']/.exec(line);
				if (match && NODE_BUILTINS.test(match[1])) {
					nodeImports.push(finding({ file: file.rel, line: index + 1, evidence: line.trim(), detail: `imports Node built-in "${match[1]}"`, severity: "high" }));
				}
			});
		}
		const desktopOnly = ctx.manifest.isDesktopOnly === true;
		const consistent = nodeImports.length === 0 || desktopOnly;

		out.push(result({
			id: "manifest-desktop-only",
			title: "isDesktopOnly is set when Node.js or Electron APIs are used",
			status: consistent ? STATUS.PASS : STATUS.FAIL,
			severity: "high",
			...meta("OBS-SUB-004"),
			summary: nodeImports.length
				? `${nodeImports.length} Node built-in import(s); isDesktopOnly=${desktopOnly}`
				: `no Node built-in imports; isDesktopOnly=${desktopOnly}`,
			findings: consistent ? [] : nodeImports,
			remediation: 'Set "isDesktopOnly": true in manifest.json, or remove the Node.js imports.',
		}));
	}

	// ── OBS-SUB-001: fundingUrl ─────────────────────────────────────────────
	{
		const funding = ctx.manifest.fundingUrl;
		const ok = funding === undefined
			|| (typeof funding === "string" && /^https:\/\//.test(funding))
			|| (typeof funding === "object" && funding !== null && Object.values(funding).every(v => /^https:\/\//.test(String(v))));

		out.push(result({
			id: "manifest-funding-url",
			title: "fundingUrl is absent or a valid https link",
			status: ok ? STATUS.PASS : STATUS.WARNING,
			severity: "low",
			...meta("OBS-SUB-001"),
			summary: funding === undefined ? "fundingUrl is not set" : `fundingUrl is ${JSON.stringify(funding)}`,
			remediation: "Remove fundingUrl if you do not accept donations, otherwise point it at an https funding page.",
		}));
	}

	// ── OBS-SUB-005: command ids ────────────────────────────────────────────
	{
		const pluginId = String(ctx.manifest.id ?? "");
		const offenders = [];
		for (const file of ctx.sources.values()) {
			file.lines.forEach((line, index) => {
				const match = /\bid:\s*["']([^"']+)["']/.exec(line);
				if (match && pluginId && match[1].startsWith(`${pluginId}-`)) {
					offenders.push(finding({ file: file.rel, line: index + 1, evidence: line.trim(), detail: `command id repeats the plugin id "${pluginId}"`, severity: "low" }));
				}
			});
		}

		out.push(result({
			id: "command-id-prefix",
			title: "Command ids do not repeat the plugin id",
			status: offenders.length ? STATUS.WARNING : STATUS.PASS,
			severity: "low",
			...meta("OBS-SUB-005"),
			summary: offenders.length ? `${offenders.length} command id(s) start with "${pluginId}-"` : "no command id repeats the plugin id",
			findings: offenders,
			remediation: "Drop the plugin id prefix; Obsidian adds it automatically.",
		}));
	}

	// ── OBS-SUB-006: sample code ────────────────────────────────────────────
	{
		const hits = ctx.grepSources(/\b(MyPlugin|MyPluginSettings|SampleSettingTab|SampleModal|MyModal)\b/);
		out.push(result({
			id: "no-sample-code",
			title: "Sample plugin code has been removed",
			status: hits.length ? STATUS.FAIL : STATUS.PASS,
			severity: "low",
			...meta("OBS-SUB-006"),
			summary: hits.length ? `${hits.length} sample-plugin identifier(s) remain` : "no sample-plugin identifiers found",
			findings: hits.map(h => finding({ ...h, detail: "sample plugin identifier", severity: "low" })),
			remediation: "Rename the placeholder classes to names that describe this plugin.",
		}));
	}

	// ── OBS-GUIDE-005: HTML injection sinks ─────────────────────────────────
	{
		const hits = ctx.grepSources(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|setHTMLUnsafe\s*\(/, { skipComments: true });
		out.push(result({
			id: "no-html-injection-sinks",
			title: "No innerHTML / outerHTML / insertAdjacentHTML",
			status: hits.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			...meta("OBS-GUIDE-005"),
			summary: hits.length ? `${hits.length} HTML sink(s) found` : "no HTML injection sinks in src/",
			findings: hits.map(h => finding({ ...h, detail: "HTML injection sink", severity: "high" })),
			remediation: "Build the DOM with createEl()/createDiv()/createSpan() or textContent instead.",
		}));
	}

	// ── OBS-GUIDE-001: global app ───────────────────────────────────────────
	{
		// A parameter typed `app: App` is the documented way to pass the instance
		// around, so files that declare one are not evidence of global usage.
		const hits = ctx.grepSources(
			/\bwindow\.app\b|\bglobalThis\.app\b|(?<![.\w])app\.(?:workspace|vault|metadataCache)\b/,
			{ skipComments: true, skipFile: file => /\bapp\s*:\s*App\b/.test(file.text) },
		);
		out.push(result({
			id: "no-global-app",
			title: "No use of the global app instance",
			status: hits.length ? STATUS.WARNING : STATUS.PASS,
			severity: "low",
			...meta("OBS-GUIDE-001"),
			summary: hits.length ? `${hits.length} possible global app usage(s)` : "app is always reached through the plugin/view instance",
			findings: hits.map(h => finding({ ...h, detail: "possible global app usage", severity: "low" })),
			remediation: "Use this.app (plugin) or this.plugin.app (view) instead of the global app object.",
		}));
	}

	// ── OBS-OO-002: requestUrl only ─────────────────────────────────────────
	{
		const hits = ctx.grepSources(/(?<![.\w])fetch\s*\(|new\s+XMLHttpRequest|new\s+WebSocket|navigator\.sendBeacon|require\(["']axios["']\)|from\s+["']axios["']/, { skipComments: true });
		const usesRequestUrl = ctx.grepSources(/\brequestUrl\s*\(/).length > 0;
		out.push(result({
			id: "request-url-only",
			title: "All network calls go through Obsidian requestUrl",
			status: hits.length ? STATUS.FAIL : STATUS.PASS,
			severity: "medium",
			...meta("OBS-OO-002"),
			summary: hits.length
				? `${hits.length} direct network call(s) bypassing requestUrl`
				: `no fetch/XHR/WebSocket/sendBeacon in src/; requestUrl ${usesRequestUrl ? "is" : "is not"} used`,
			findings: hits.map(h => finding({ ...h, detail: "network call outside requestUrl", severity: "medium" })),
			remediation: "Replace the call with requestUrl() from the obsidian package.",
		}));
	}

	// ── OBS-OO-006: FileSystemAdapter guarded ───────────────────────────────
	{
		const uses = ctx.grepSources(/FileSystemAdapter/);
		const guarded = ctx.grepSources(/instanceof\s+FileSystemAdapter/);
		// Import lines and type positions are not casts; only an unguarded value use matters.
		const unguardedCandidates = uses.filter(h =>
			!/^import\b/.test(h.evidence) &&
			!/instanceof\s+FileSystemAdapter/.test(h.evidence),
		);
		const ok = unguardedCandidates.length === 0 || guarded.length > 0;
		out.push(result({
			id: "filesystem-adapter-guard",
			title: "FileSystemAdapter is only used behind an instanceof guard",
			status: ok ? STATUS.PASS : STATUS.WARNING,
			severity: "medium",
			...meta("OBS-OO-006"),
			summary: uses.length
				? `${uses.length} reference(s), ${guarded.length} instanceof guard(s)`
				: "FileSystemAdapter is not used",
			findings: ok ? [] : unguardedCandidates.map(h => finding({ ...h, detail: "unguarded FileSystemAdapter use", severity: "medium" })),
			remediation: "Wrap the usage in `if (adapter instanceof FileSystemAdapter)`.",
		}));
	}

	// ── OBS-OO-008: `as any` ────────────────────────────────────────────────
	{
		const hits = ctx.grepSources(/\bas\s+any\b|:\s*any\b/, { skipComments: true });
		out.push(result({
			id: "no-any-casts",
			title: "No `any` casts in the plugin source",
			status: hits.length ? STATUS.WARNING : STATUS.PASS,
			severity: "low",
			...meta("OBS-OO-008"),
			summary: hits.length ? `${hits.length} use(s) of any` : "no `any` in src/",
			findings: hits.map(h => finding({ ...h, detail: "any type", severity: "low" })),
			remediation: "Replace `any` with a precise type or `unknown` plus a type guard.",
		}));
	}

	// ── OBS-OO-009: hardcoded .obsidian ─────────────────────────────────────
	{
		const hits = ctx.grepSources(/["'][^"']*\.obsidian[/"']/, { skipComments: true });
		out.push(result({
			id: "no-hardcoded-config-dir",
			title: "The .obsidian configuration directory is not hardcoded",
			status: hits.length ? STATUS.FAIL : STATUS.PASS,
			severity: "medium",
			...meta("OBS-OO-009"),
			summary: hits.length ? `${hits.length} hardcoded config path(s)` : "configDir is always read from the vault",
			findings: hits.map(h => finding({ ...h, detail: "hardcoded .obsidian path", severity: "medium" })),
			remediation: "Use app.vault.configDir or plugin.manifest.dir instead of a literal path.",
		}));
	}

	// ── OBS-OO-004: trashFile ───────────────────────────────────────────────
	{
		// Only vault-file deletion matters. The plugin's own data files live outside
		// the vault and are removed with fs.unlink, which trashFile does not cover.
		const hits = ctx.grepSources(/\bvault\.delete\s*\(|\bvault\.adapter\.remove\s*\(/, { skipComments: true });
		out.push(result({
			id: "trash-file-usage",
			title: "Vault files are trashed rather than hard-deleted",
			status: hits.length ? STATUS.WARNING : STATUS.PASS,
			severity: "medium",
			...meta("OBS-OO-004"),
			summary: hits.length ? `${hits.length} direct vault deletion(s)` : "no direct vault file deletion",
			findings: hits.map(h => finding({ ...h, detail: "direct vault deletion", severity: "medium" })),
			remediation: "Use app.fileManager.trashFile() so the user's trash preference is honoured.",
		}));
	}

	// ── OBS-GUIDE-015: Vault vs Adapter API ─────────────────────────────────
	{
		const hits = ctx.grepSources(/vault\.adapter\b/, { skipComments: true });
		out.push(result({
			id: "vault-api-preference",
			title: "Adapter API usage is limited and justified",
			status: hits.length ? STATUS.MANUAL_REVIEW : STATUS.PASS,
			severity: "medium",
			reason: hits.length
				? "The plugin stores its own data files inside the plugin folder, which the Vault API does not address; each adapter call needs a human to confirm it is the plugin's own storage and not a user note."
				: undefined,
			...meta("OBS-GUIDE-015"),
			summary: `${hits.length} vault.adapter reference(s)`,
			findings: hits.map(h => finding({ ...h, detail: "Adapter API usage", severity: "low" })),
			remediation: "Where the target is a user note, switch to the Vault API (getFileByPath, read, process).",
		}));
	}

	// ── OBS-GUIDE-002 / logging hygiene ─────────────────────────────────────
	{
		const consoleCalls = ctx.grepSources(/console\.(log|debug|info|warn|error|trace)\s*\(/);

		// The privacy-relevant question is not how many logs there are, but whether
		// any of them can carry note content, a prompt, history or a credential.
		// An error message and a file path are diagnostics, not user content, so
		// they are removed before the dangerous identifiers are matched — otherwise
		// `error.message` would trip a rule aimed at `this.messages`.
		const SAFE_SUBEXPRESSIONS = [
			/\(\s*e\s+as\s+Error\s*\)\??\.message/g,
			/\b(?:e|err|error|_error)\??\.message\b/g,
			/\b(?:file|f|abstractFile)\??\.path\b/g,
			/\b(?:filePath|dirPath|srcDir|dstDir|srcFile|dstFile|keysPath|indexPath|path)\b/g,
			/\berrorMessage\s*\(/g,
			/\bsanitizeErrorDetail\s*\([^)]*\)/g,
		];
		const DANGEROUS = /\b(apiKey|claudeApiKey|localApiKey|secret|token|Authorization|systemMsg|systemPrompt|ragSources|chunks?|this\.messages|payloadMessages|reply|userText|noteContent)\b|response\.(text|json)\b|\bcontent\b(?!\s*=)/;

		const dangerous = consoleCalls.filter(h => {
			let stripped = h.evidence;
			for (const safe of SAFE_SUBEXPRESSIONS) stripped = stripped.replace(safe, "");
			return DANGEROUS.test(stripped);
		});
		out.push(result({
			id: "logging-hygiene",
			title: "No note content, prompts, history or credentials reach the console",
			status: dangerous.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			...meta("OBS-GUIDE-002"),
			summary: dangerous.length
				? `${dangerous.length} logging call(s) may carry user content or a credential (out of ${consoleCalls.length} total)`
				: `${consoleCalls.length} console call(s), none passing user content or credentials`,
			findings: dangerous.map(h => finding({ ...h, detail: "log statement may carry user content or a credential", severity: "high" })),
			remediation: "Log only a stable message plus sanitizeErrorDetail() output; never a note body, prompt, chunk or key.",
		}));
	}

	// ── OBS-POL-015: trademark ──────────────────────────────────────────────
	{
		const name = String(ctx.manifest.name ?? "");
		const id = String(ctx.manifest.id ?? "");
		const problems = [];
		if (/^obsidian/i.test(name)) problems.push(`manifest name "${name}" starts with "Obsidian"`);
		if (/^obsidian/i.test(id)) problems.push(`manifest id "${id}" starts with "obsidian"`);
		if (ctx.docs.readme && /\bofficial\s+obsidian\b/i.test(ctx.docs.readme)) problems.push('README claims to be an "official Obsidian" project');

		out.push(result({
			id: "trademark-usage",
			title: "The Obsidian trademark is not used in a confusing way",
			status: problems.length ? STATUS.FAIL : STATUS.MANUAL_REVIEW,
			severity: "low",
			reason: problems.length ? undefined : "Automated checks can only catch the obvious cases; whether the branding could confuse a user is a human judgement.",
			...meta("OBS-POL-015"),
			summary: problems.length ? problems.join("; ") : `name "${name}", id "${id}" — no first-party implication detected`,
			findings: problems.map(p => finding({ file: "manifest.json", detail: p, severity: "low" })),
			remediation: "Rename so the plugin cannot be mistaken for a first-party Obsidian feature.",
		}));
	}

	// ── OBS-POL-016: forks ──────────────────────────────────────────────────
	out.push(result({
		id: "fork-policy",
		title: "Fork policy",
		status: STATUS.MANUAL_REVIEW,
		reason: "Whether this project is a fork of another plugin, and whether the original author approved it, cannot be established from the repository contents.",
		...meta("OBS-POL-016"),
		summary: "Requires the maintainer to confirm the project's origin.",
		remediation: "If this is a fork, document the original author's written approval in the README and credit them as a contributor.",
	}));

	// ── OBS-POL-003 / OBS-POL-010: ads ──────────────────────────────────────
	{
		const adSignals = ctx.grepSources(/\b(advert|sponsor|promoted|adsense|doubleclick|banner_ad)\b/i);
		out.push(result({
			id: "no-ads",
			title: "No advertising inside or outside the plugin interface",
			status: adSignals.length ? STATUS.MANUAL_REVIEW : STATUS.PASS,
			severity: "low",
			reason: adSignals.length ? "Ad-related identifiers were found and need a human to classify." : undefined,
			...meta("OBS-POL-003"),
			summary: adSignals.length ? `${adSignals.length} ad-related identifier(s)` : "no advertising code found",
			findings: adSignals.map(h => finding({ ...h, detail: "ad-related identifier", severity: "low" })),
		}));
	}

	// ── OBS-SEC-002: SecretStorage adoption ─────────────────────────────────
	{
		const usesSecretStorage = ctx.grepSources(/\bsecretStorage\b|\bSecretComponent\b/).length > 0;
		const rule = ctx.rule("OBS-SEC-002");
		out.push(result({
			id: "secret-storage-adoption",
			title: "API keys use the Obsidian SecretStorage API",
			status: usesSecretStorage ? STATUS.PASS : STATUS.MANUAL_REVIEW,
			severity: "high",
			reason: usesSecretStorage ? undefined :
				`Keys are stored by the plugin itself (keys.json outside the vault, or data.json when the user opts into Obsidian Sync) rather than in SecretStorage. Adopting SecretStorage requires raising minAppVersion from ${ctx.manifest.minAppVersion} to the 1.11.x line, which drops support for existing installs — a product decision, not an automated fix.`,
			...meta("OBS-SEC-002"),
			summary: usesSecretStorage
				? "app.secretStorage / SecretComponent are in use"
				: `SecretStorage is not used; minAppVersion is ${ctx.manifest.minAppVersion}`,
			remediation: rule?.notes ?? "Evaluate migrating to app.secretStorage and SecretComponent, including a reversible migration for existing keys.",
		}));
	}

	return out;
}
