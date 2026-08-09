/**
 * Test runner for AI-Vault.
 *
 * Deliberately built on tools the repository already has: esbuild (already a
 * devDependency, already used for the plugin bundle) transpiles the TypeScript
 * tests, and Node's built-in `node:test` runner executes them. No new
 * dependency is added to the supply chain just to run unit tests.
 *
 * Usage: node scripts/run-tests.mjs [--watch]
 */

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = join(ROOT, "tests");
const OUT_DIR = join(ROOT, ".testbuild");

/** Recursively collects every *.test.ts under `dir`. */
async function collectTests(dir) {
	const found = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return found;
		throw error;
	}

	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await collectTests(full)));
		} else if (entry.name.endsWith(".test.ts")) {
			found.push(full);
		}
	}
	return found;
}

async function main() {
	const entryPoints = (await collectTests(TESTS_DIR)).sort();
	if (entryPoints.length === 0) {
		console.error("No test files found under tests/. Refusing to report success on an empty suite.");
		process.exit(1);
	}

	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(OUT_DIR, { recursive: true });

	await build({
		entryPoints,
		outdir: OUT_DIR,
		outbase: TESTS_DIR,
		outExtension: { ".js": ".mjs" },
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		sourcemap: "inline",
		logLevel: "warning",
		// Node built-ins stay external; `obsidian` is not importable outside the app,
		// so any test that reaches it fails loudly instead of silently stubbing it.
		external: ["node:*", "obsidian"],
	});

	console.log(`Compiled ${entryPoints.length} test file(s) to ${relative(ROOT, OUT_DIR)}/`);

	// Explicit file paths rather than a directory: directory discovery rules have
	// changed between Node majors, and a runner that silently finds nothing would
	// report a green build for zero tests.
	const compiled = entryPoints.map(entry =>
		join(OUT_DIR, relative(TESTS_DIR, entry).replace(/\.ts$/, ".mjs")),
	);

	const watch = process.argv.includes("--watch");
	const junitPath = join(OUT_DIR, "results.junit.xml");

	const args = ["--test"];
	if (watch) {
		args.push("--watch");
	} else {
		// Two reporters: the readable one stays on stdout, and JUnit goes to a file
		// so the run can report "175/175" instead of only an exit code.
		args.push("--test-reporter=spec", "--test-reporter-destination=stdout");
		args.push("--test-reporter=junit", `--test-reporter-destination=${junitPath}`);
	}
	args.push(...compiled);

	const child = spawn(process.execPath, args, { stdio: "inherit", cwd: ROOT });
	const code = await new Promise(resolve => child.on("exit", value => resolve(value ?? 1)));

	if (!watch) await reportCounts(junitPath);
	process.exit(code);
}

/**
 * Turns the JUnit output into a one-line score, and in CI into a step-summary
 * line and job outputs the publication gate can render.
 *
 * Counts `<testcase>` and `<failure>` elements rather than summing the `tests`
 * attribute of each `<testsuite>`: nested `describe` blocks produce nested
 * suites, and summing their attributes double-counts.
 *
 * Never touches the exit code. A reporting problem must not turn a red run green
 * — nor a green run red.
 */
async function reportCounts(junitPath) {
	let total;
	let failed;
	try {
		const xml = await readFile(junitPath, "utf8");
		total = (xml.match(/<testcase\b/g) ?? []).length;
		failed = (xml.match(/<failure\b/g) ?? []).length;
	} catch {
		return; // no report file — nothing to say, and nothing to break
	}
	if (!total) return;

	const passed = total - failed;
	const line = `${passed}/${total} tests passed${failed ? `, ${failed} failed` : ""}`;
	console.log(`\n${line}`);

	await appendIfSet("GITHUB_STEP_SUMMARY", `### Unit tests\n\n${failed ? "❌" : "✅"} ${line}\n\n`);
	await appendIfSet("GITHUB_OUTPUT", `tests_total=${total}\ntests_passed=${passed}\ntests_failed=${failed}\n`);
}

/** Appends to the file named by an environment variable, when that variable is set. */
async function appendIfSet(envVar, text) {
	const path = process.env[envVar];
	if (!path) return;
	try {
		await appendFile(path, text);
	} catch (error) {
		console.error(`Could not write to ${envVar}:`, error?.message ?? error);
	}
}

/** Guards against a stale build directory being mistaken for fresh results. */
async function assertWritable() {
	try {
		const info = await stat(ROOT);
		if (!info.isDirectory()) throw new Error("Repository root is not a directory");
	} catch (error) {
		console.error("Cannot access repository root:", error?.message ?? error);
		process.exit(1);
	}
}

await assertWritable();
await main();
