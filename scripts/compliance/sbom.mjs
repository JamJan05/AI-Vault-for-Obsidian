/**
 * CycloneDX 1.5 SBOM generator.
 *
 * Built from package-lock.json rather than from a third-party generator, so the
 * SBOM step does not itself add a dependency to the supply chain it describes.
 *
 * Usage: node scripts/compliance/sbom.mjs [outfile]
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** package-lock entry key → CycloneDX purl. */
function purlFor(name, version) {
	const [scope, bare] = name.startsWith("@") ? name.split("/") : [null, name];
	const encoded = scope ? `${encodeURIComponent(scope)}/${bare}` : encodeURIComponent(name);
	return `pkg:npm/${encoded}@${version}`;
}

function licenseEntry(license) {
	if (!license) return undefined;
	if (typeof license === "string") {
		// A compound SPDX expression cannot go in `license.id`.
		return /\s(?:OR|AND)\s|[()]/.test(license)
			? [{ expression: license }]
			: [{ license: { id: license } }];
	}
	return undefined;
}

export async function buildSbom() {
	const [pkg, lockText] = await Promise.all([
		readFile(join(ROOT, "package.json"), "utf8").then(JSON.parse),
		readFile(join(ROOT, "package-lock.json"), "utf8"),
	]);
	const lock = JSON.parse(lockText);

	const components = [];
	const dependencies = new Map();

	for (const [key, entry] of Object.entries(lock.packages ?? {})) {
		if (!key) continue; // the root project itself
		const name = entry.name ?? key.replace(/^node_modules\//, "").replace(/.*\/node_modules\//, "");
		if (!name || !entry.version) continue;

		const purl = purlFor(name, entry.version);
		const component = {
			type: "library",
			"bom-ref": purl,
			name,
			version: entry.version,
			purl,
			scope: entry.dev ? "excluded" : "required",
			properties: [
				{ name: "npm:dev", value: String(Boolean(entry.dev)) },
				{ name: "npm:path", value: key },
				...(entry.hasInstallScript ? [{ name: "npm:hasInstallScript", value: "true" }] : []),
			],
		};

		const licenses = licenseEntry(entry.license);
		if (licenses) component.licenses = licenses;

		if (entry.resolved) component.externalReferences = [{ type: "distribution", url: entry.resolved }];
		if (entry.integrity) {
			const [algorithm, value] = String(entry.integrity).split("-");
			const algMap = { sha512: "SHA-512", sha256: "SHA-256", sha1: "SHA-1" };
			if (algMap[algorithm] && value) {
				component.hashes = [{
					alg: algMap[algorithm],
					content: Buffer.from(value, "base64").toString("hex"),
				}];
			}
		}

		components.push(component);
		dependencies.set(purl, Object.keys(entry.dependencies ?? {}));
	}

	components.sort((a, b) => a.purl.localeCompare(b.purl));

	const rootRef = purlFor(pkg.name, pkg.version);
	return {
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		serialNumber: `urn:uuid:${deterministicUuid(lockText)}`,
		version: 1,
		metadata: {
			// A fixed timestamp would be reproducible but misleading; the SBOM
			// describes the tree at the moment it was generated.
			timestamp: new Date().toISOString(),
			tools: [{ vendor: "AI-Vault", name: "scripts/compliance/sbom.mjs", version: "1.0.0" }],
			component: {
				type: "application",
				"bom-ref": rootRef,
				name: pkg.name,
				version: pkg.version,
				purl: rootRef,
				description: pkg.description,
				licenses: licenseEntry(pkg.license),
			},
		},
		components,
		dependencies: [
			{ ref: rootRef, dependsOn: components.filter(c => /^node_modules\/[^/]+$/.test(c.properties.find(p => p.name === "npm:path")?.value ?? "")).map(c => c["bom-ref"]) },
			...components.map(c => ({ ref: c["bom-ref"], dependsOn: [] })),
		],
	};
}

/** Stable UUID derived from the lockfile, so an unchanged tree yields the same serial. */
function deterministicUuid(input) {
	const hex = createHash("sha256").update(input).digest("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		`4${hex.slice(13, 16)}`,
		((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
		hex.slice(20, 32),
	].join("-");
}

/** Structural validation, so a broken SBOM fails loudly instead of shipping. */
export function validateSbom(sbom) {
	const problems = [];
	if (sbom.bomFormat !== "CycloneDX") problems.push("bomFormat is not CycloneDX");
	if (!/^1\.\d$/.test(sbom.specVersion)) problems.push(`unexpected specVersion "${sbom.specVersion}"`);
	if (!Array.isArray(sbom.components)) problems.push("components is not an array");
	if (!sbom.metadata?.component?.name) problems.push("metadata.component.name is missing");
	for (const component of sbom.components ?? []) {
		if (!component.name || !component.version || !component.purl) {
			problems.push(`component ${component.name ?? "?"} is missing name, version or purl`);
		}
	}
	return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const outfile = process.argv[2] ?? join(ROOT, "sbom.cdx.json");
	const sbom = await buildSbom();
	const problems = validateSbom(sbom);
	if (problems.length) {
		console.error("SBOM validation failed:\n - " + problems.join("\n - "));
		process.exit(1);
	}
	await writeFile(outfile, JSON.stringify(sbom, null, 2) + "\n");
	console.log(`SBOM written to ${outfile} (${sbom.components.length} components)`);
}
