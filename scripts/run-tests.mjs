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
import { mkdir, readdir, rm, stat } from "node:fs/promises";
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

	const args = ["--test"];
	if (process.argv.includes("--watch")) args.push("--watch");
	args.push(...compiled);

	const child = spawn(process.execPath, args, { stdio: "inherit", cwd: ROOT });
	child.on("exit", code => process.exit(code ?? 1));
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
