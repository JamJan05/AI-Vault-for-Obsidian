/**
 * Result model shared by every compliance check.
 *
 * The vocabulary is fixed on purpose. A check that cannot be evaluated reports
 * BLOCKED or MANUAL_REVIEW — never PASS. Nothing in this file lets a caller turn
 * a FAIL into a WARNING; severity and status come from the check itself.
 */

/** @typedef {"PASS"|"FAIL"|"WARNING"|"MANUAL_REVIEW"|"BLOCKED"|"NOT_APPLICABLE"} Status */
/** @typedef {"critical"|"high"|"medium"|"low"|"informational"} Severity */

export const STATUS = Object.freeze({
	PASS: "PASS",
	FAIL: "FAIL",
	WARNING: "WARNING",
	MANUAL_REVIEW: "MANUAL_REVIEW",
	BLOCKED: "BLOCKED",
	NOT_APPLICABLE: "NOT_APPLICABLE",
});

export const SEVERITY_ORDER = Object.freeze(["informational", "low", "medium", "high", "critical"]);

/** Statuses that must stop a release. */
export const BLOCKING_STATUSES = Object.freeze([STATUS.FAIL, STATUS.BLOCKED]);

/**
 * @param {object} input
 * @param {string} input.id           Stable check id, matching `checkId` in the policy map.
 * @param {string} input.title        Human-readable name.
 * @param {Status} input.status
 * @param {Severity} [input.severity] Required for FAIL and WARNING.
 * @param {string} [input.rule]       Policy rule id (e.g. OBS-POL-004).
 * @param {string} [input.source]     URL of the rule.
 * @param {string} [input.summary]    One sentence describing the outcome.
 * @param {Array<object>} [input.findings]
 * @param {string} [input.remediation]
 * @param {string} [input.reason]     Why a check is BLOCKED / MANUAL_REVIEW / NOT_APPLICABLE.
 * @param {boolean} [input.blocksRelease]
 */
export function result(input) {
	const status = input.status;
	if (!Object.values(STATUS).includes(status)) {
		throw new Error(`Unknown status "${status}" for check ${input.id}`);
	}
	if ((status === STATUS.FAIL || status === STATUS.WARNING) && !input.severity) {
		throw new Error(`Check ${input.id} reported ${status} without a severity`);
	}
	if ((status === STATUS.BLOCKED || status === STATUS.MANUAL_REVIEW || status === STATUS.NOT_APPLICABLE) && !input.reason) {
		throw new Error(`Check ${input.id} reported ${status} without a reason`);
	}

	return {
		id: input.id,
		title: input.title,
		status,
		severity: input.severity ?? "informational",
		rule: input.rule ?? null,
		source: input.source ?? null,
		summary: input.summary ?? "",
		reason: input.reason ?? null,
		remediation: input.remediation ?? null,
		findings: input.findings ?? [],
		blocksRelease: input.blocksRelease ?? BLOCKING_STATUSES.includes(status),
		attempts: 1,
	};
}

/**
 * A single piece of evidence inside a check result.
 * `evidence` is sanitized by the reporter before it is written anywhere.
 */
export function finding({ file, line = null, evidence = "", detail = "", severity = "medium" }) {
	return { file, line, evidence, detail, severity };
}

/** Highest severity among the results that are FAIL or WARNING. */
export function highestSeverity(results) {
	let highest = "informational";
	for (const r of results) {
		if (r.status !== STATUS.FAIL && r.status !== STATUS.WARNING) continue;
		if (SEVERITY_ORDER.indexOf(r.severity) > SEVERITY_ORDER.indexOf(highest)) highest = r.severity;
	}
	return highest;
}

export function countByStatus(results) {
	const counts = { PASS: 0, FAIL: 0, WARNING: 0, MANUAL_REVIEW: 0, BLOCKED: 0, NOT_APPLICABLE: 0 };
	for (const r of results) counts[r.status] += 1;
	return counts;
}
