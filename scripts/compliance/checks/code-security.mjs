/**
 * Code-level security checks: dynamic execution, obfuscation, path handling,
 * URL policy wiring and error/log redaction.
 */

import ts from "typescript";

import { STATUS, finding, result } from "../lib/model.mjs";

/**
 * Locates every `JSON.parse` call in a file and reports whether it sits inside a
 * `try` block.
 *
 * This uses the TypeScript parser rather than brace counting. Counting braces by
 * hand cannot survive a regex literal such as `/[\\/:*?"<>|]/` — the quote inside
 * it starts a phantom string and every depth after that point is wrong. TypeScript
 * is already a devDependency, so this adds nothing to the supply chain.
 */
function findJsonParseCalls(file) {
	const source = ts.createSourceFile(file.rel, file.text, ts.ScriptTarget.ES2022, true);
	const calls = [];

	const isJsonParse = node =>
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === "parse" &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === "JSON";

	const walk = (node, guarded) => {
		if (ts.isTryStatement(node)) {
			// Only the try block is guarded. Code in catch or finally is not.
			walk(node.tryBlock, true);
			if (node.catchClause) walk(node.catchClause, guarded);
			if (node.finallyBlock) walk(node.finallyBlock, guarded);
			return;
		}

		if (isJsonParse(node)) {
			const position = source.getLineAndCharacterOfPosition(node.getStart(source));
			calls.push({
				file: file.rel,
				line: position.line + 1,
				evidence: (file.lines[position.line] ?? "").trim(),
				guarded,
			});
		}

		ts.forEachChild(node, child => walk(child, guarded));
	};

	walk(source, false);
	return calls;
}

export async function run(ctx) {
	const out = [];
	const meta = id => ctx.ruleMeta(id);

	// ── Dynamic execution ───────────────────────────────────────────────────
	{
		const opts = { skipComments: true };
		const hits = [
			...ctx.grepSources(/(?<![.\w])eval\s*\(/, opts),
			...ctx.grepSources(/new\s+Function\s*\(/, opts),
			...ctx.grepSources(/\bchild_process\b|\bexecSync\b|\bspawnSync?\s*\(|\bexecFile\s*\(/, opts),
			...ctx.grepSources(/\bvm\.runIn/, opts),
		];
		out.push(result({
			id: "no-dynamic-execution",
			title: "No eval, Function constructor or child process execution",
			status: hits.length ? STATUS.FAIL : STATUS.PASS,
			severity: "critical",
			...meta("OBS-POL-005"),
			summary: hits.length ? `${hits.length} dynamic-execution site(s)` : "no eval / Function / child_process in src/",
			findings: hits.map(h => finding({ ...h, detail: "dynamic code execution", severity: "critical" })),
			remediation: "Remove the dynamic execution. A model reply must never be executed as code or as a shell command.",
		}));
	}

	// ── Self-update ─────────────────────────────────────────────────────────
	{
		const opts = { skipComments: true };
		const hits = [
			...ctx.grepSources(/await\s+import\s*\(\s*[^"')]*(?:url|href|endpoint)/i, opts),
			...ctx.grepSources(/\bnpm\s+(install|i)\b|\byarn\s+add\b|\bpnpm\s+add\b/, opts),
			...ctx.grepSources(/manifest\.dir[^\n]*write|writeFile[^\n]*main\.js/, opts),
		];
		out.push(result({
			id: "no-self-update",
			title: "The plugin does not install or update itself or its dependencies",
			status: hits.length ? STATUS.FAIL : STATUS.PASS,
			severity: "critical",
			...meta("OBS-POL-005"),
			summary: hits.length ? `${hits.length} self-update indicator(s)` : "no code downloads or writes into the plugin directory",
			findings: hits.map(h => finding({ ...h, detail: "possible self-update mechanism", severity: "critical" })),
			remediation: "Remove the mechanism. Obsidian forbids plugins from installing or updating themselves or their dependencies.",
		}));
	}

	// ── Obfuscation ─────────────────────────────────────────────────────────
	{
		const problems = [];
		for (const file of ctx.sources.values()) {
			const longestLine = file.lines.reduce((max, line) => Math.max(max, line.length), 0);
			if (file.lines.length <= 3 && file.text.length > 5000) {
				problems.push(finding({ file: file.rel, detail: `single-line source file of ${file.text.length} bytes`, severity: "critical" }));
			}
			if (longestLine > 2000) {
				problems.push(finding({ file: file.rel, detail: `line of ${longestLine} characters`, severity: "medium" }));
			}
			// A long base64 or hex blob in source is the classic packed-payload shape.
			const blobs = file.text.match(/["'][A-Za-z0-9+/]{500,}={0,2}["']/g) ?? [];
			for (const blob of blobs) {
				problems.push(finding({ file: file.rel, detail: `encoded blob of ${blob.length} characters`, severity: "high" }));
			}
			const hexBlobs = file.text.match(/(?:\\x[0-9a-f]{2}){40,}/gi) ?? [];
			for (const blob of hexBlobs) {
				problems.push(finding({ file: file.rel, detail: `hex-escaped blob of ${blob.length} characters`, severity: "high" }));
			}
		}

		out.push(result({
			id: "no-obfuscation",
			title: "The source is not obfuscated",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "critical",
			...meta("OBS-POL-001"),
			summary: problems.length
				? `${problems.length} obfuscation indicator(s)`
				: `${ctx.sources.size} source files, all readable; the release bundle is minified, which is not obfuscation`,
			findings: problems,
			remediation: "Ship readable TypeScript. Minifying the release bundle is fine; hiding the purpose of the code is not.",
		}));
	}

	// ── URL policy is actually wired in ─────────────────────────────────────
	{
		const hasModule = [...ctx.sources.values()].some(f => f.rel === "src/security/urlPolicy.ts");
		const usedInApi = ctx.grepSources(/assessLocalBaseUrl/).filter(h => h.file.startsWith("src/api/"));
		const usedInUi = ctx.grepSources(/assessLocalBaseUrl/).filter(h => h.file.includes("SettingsTab"));
		const problems = [];
		if (!hasModule) problems.push("src/security/urlPolicy.ts is missing");
		if (!usedInApi.length) problems.push("the API layer does not validate the Base URL before sending data");
		if (!usedInUi.length) problems.push("the settings UI does not warn about a risky Base URL");

		out.push(result({
			id: "local-url-validation",
			title: "The Local API Base URL is validated centrally and warned about in the UI",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			rule: "AIV-URL-001",
			source: "https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html",
			summary: problems.length ? problems.join("; ") : "assessLocalBaseUrl guards both the request path and the settings UI",
			findings: problems.map(p => finding({ file: "src/security/urlPolicy.ts", detail: p, severity: "high" })),
			remediation: "Route every Base URL through assessLocalBaseUrl(): refuse forbidden schemes, and show a visible warning before data is sent to a non-loopback plaintext endpoint.",
		}));
	}

	// ── Untrusted response bodies never reach a message verbatim ────────────
	{
		const raw = ctx.grepSources(/throw new Error\([^)]*response\.text|`[^`]*\$\{response\.text\}/);
		const unsanitized = raw.filter(h => !/sanitizeErrorDetail|localHttpError|safeErrorMessage/.test(h.evidence));

		out.push(result({
			id: "error-redaction",
			title: "Untrusted response bodies are sanitized before they reach a message or log",
			status: unsanitized.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			rule: "AIV-LOG-001",
			source: "https://cheatsheetseries.owasp.org/cheatsheets/User_Privacy_Protection_Cheat_Sheet.html",
			summary: unsanitized.length
				? `${unsanitized.length} error message(s) embed a raw response body`
				: "every provider response body passes through sanitizeErrorDetail()",
			findings: unsanitized.map(h => finding({ ...h, detail: "raw response body in an error message", severity: "high" })),
			remediation: "Wrap the value in sanitizeErrorDetail() from src/security/redact.ts, which redacts credentials, strips control characters and caps the length.",
		}));
	}

	// ── Path containment is wired into external storage ─────────────────────
	{
		const hasModule = [...ctx.sources.values()].some(f => f.rel === "src/security/paths.ts");
		const usedInStorage = ctx.grepSources(/isPathInside|isUnsafePathSegment|safeJoinInside/)
			.filter(h => h.file.startsWith("src/storage/"));
		const problems = [];
		if (!hasModule) problems.push("src/security/paths.ts is missing");
		if (!usedInStorage.length) problems.push("ExternalStorage does not enforce path containment");

		out.push(result({
			id: "path-containment",
			title: "File paths outside the vault are confined to the data directory",
			status: problems.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			rule: "AIV-FS-001",
			source: "https://owasp.org/www-project-application-security-verification-standard/",
			summary: problems.length ? problems.join("; ") : `containment enforced at ${usedInStorage.length} site(s) in src/storage/`,
			findings: problems.map(p => finding({ file: "src/storage/ExternalStorage.ts", detail: p, severity: "high" })),
			remediation: "Reject any path segment containing '..', an absolute path or a NUL byte, and verify the resolved path is still inside the base directory.",
		}));
	}

	// ── Atomic writes ───────────────────────────────────────────────────────
	{
		const atomic = ctx.grepSources(/\.tmp`|rename\(/).filter(h => h.file.startsWith("src/storage/"));
		out.push(result({
			id: "atomic-json-writes",
			title: "JSON files are written atomically",
			status: atomic.length ? STATUS.PASS : STATUS.WARNING,
			severity: "medium",
			rule: "AIV-FS-002",
			source: "https://owasp.org/www-project-application-security-verification-standard/",
			summary: atomic.length ? "writes go through a temp file plus rename" : "no temp-file-plus-rename pattern found in src/storage/",
			remediation: "Write to <file>.tmp and rename, so an interrupted write cannot leave corrupted history or a truncated key file.",
		}));
	}

	// ── keys.json permissions ───────────────────────────────────────────────
	{
		const restricted = ctx.grepSources(/restrictPermissions|chmod/).filter(h => /storage|main\.ts/.test(h.file));
		out.push(result({
			id: "key-file-permissions",
			title: "The key file is restricted to the current user where the platform allows it",
			status: restricted.length ? STATUS.PASS : STATUS.WARNING,
			severity: "medium",
			rule: "AIV-KEY-001",
			source: "https://owasp.org/www-project-application-security-verification-standard/",
			summary: restricted.length ? "keys.json is written with owner-only permissions" : "no permission tightening found for keys.json",
			remediation: "chmod the key file to 0600 after writing it, tolerating platforms where that has no effect.",
		}));
	}

	// ── Model output is never executed ──────────────────────────────────────
	{
		// Real execution sinks only. `regex.exec(text)` is pattern matching, not
		// process execution, and must not be confused with one.
		const EXECUTION_SINK = /(?<![.\w])eval\s*\(|new\s+Function\s*\(|\bexecSync\s*\(|\bexecFile\s*\(|\bspawn(?:Sync)?\s*\(|\.innerHTML\s*=|insertAdjacentHTML\s*\(/;
		const risky = ctx.grepSources(/\breply\b|r\.text|\bcontent\b/, { skipComments: true })
			.filter(h => EXECUTION_SINK.test(h.evidence));
		out.push(result({
			id: "model-output-not-executed",
			title: "Model output is rendered, never executed",
			status: risky.length ? STATUS.FAIL : STATUS.PASS,
			severity: "critical",
			rule: "AIV-LLM-001",
			source: "https://owasp.org/www-project-application-security-verification-standard/",
			summary: risky.length ? `${risky.length} site(s) may execute model output` : "model replies only reach the Markdown renderer and JSON parsing",
			findings: risky.map(h => finding({ ...h, detail: "model output reaching an execution sink", severity: "critical" })),
			remediation: "Render model output as text or Markdown only.",
		}));
	}

	// ── Untrusted JSON parsing is guarded ───────────────────────────────────
	{
		const calls = [...ctx.sources.values()].flatMap(findJsonParseCalls);
		const unguarded = calls.filter(c => !c.guarded);

		out.push(result({
			id: "json-parse-guarded",
			title: "Untrusted JSON is parsed inside a try/catch",
			status: unguarded.length ? STATUS.WARNING : STATUS.PASS,
			severity: "medium",
			rule: "AIV-LLM-002",
			source: "https://owasp.org/www-project-application-security-verification-standard/",
			summary: unguarded.length
				? `${unguarded.length} of ${calls.length} JSON.parse call(s) are outside a try block`
				: `all ${calls.length} JSON.parse call(s) are inside a try block`,
			findings: unguarded.map(c => finding({ file: c.file, line: c.line, evidence: c.evidence, detail: "JSON.parse outside a try block", severity: "medium" })),
			remediation: "Wrap the parse in try/catch and validate the shape before using the result. Canvas files and model replies are both untrusted.",
		}));
	}

	// ── RAG ignore list is enforced everywhere content can leave ────────────
	{
		const engine = ctx.grepSources(/ignored\.matches|isIgnoredPath|purgeIgnoredEntries/).filter(h => h.file.startsWith("src/rag/"));
		const view = ctx.grepSources(/ragIgnored|isIgnoredPath/).filter(h => h.file.startsWith("src/views/"));
		const resolver = ctx.grepSources(/isIgnored/).filter(h => h.file.includes("linkResolver"));

		const gaps = [];
		if (!engine.length) gaps.push("the RAG engine does not apply the ignore list");
		if (!view.length) gaps.push("the chat view does not filter ignored paths before building the prompt");
		if (!resolver.length) gaps.push("wikilink resolution does not respect the ignore list");

		out.push(result({
			id: "rag-ignore-enforcement",
			title: "Ignored RAG paths are enforced at indexing, retrieval and prompt assembly",
			status: gaps.length ? STATUS.FAIL : STATUS.PASS,
			severity: "high",
			rule: "AIV-RAG-001",
			source: "https://cheatsheetseries.owasp.org/cheatsheets/User_Privacy_Protection_Cheat_Sheet.html",
			summary: gaps.length
				? gaps.join("; ")
				: `enforced in the engine (${engine.length} sites), the chat view (${view.length}) and the link resolver (${resolver.length})`,
			findings: gaps.map(g => finding({ file: "src/rag/RAGEngine.ts", detail: g, severity: "high" })),
			remediation: "Filter ignored paths before reading a file, before requesting an embedding, before ranking and again before the text is put into a prompt.",
		}));
	}

	return out;
}
