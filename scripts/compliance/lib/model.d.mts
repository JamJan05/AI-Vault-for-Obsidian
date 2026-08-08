/**
 * Type contract for the compliance check modules.
 *
 * The checks are plain ESM so they can run with no build step. These declarations
 * exist so the TypeScript tests that exercise them are type-checked rather than
 * silently `any`.
 */

export type Status =
	| "PASS"
	| "FAIL"
	| "WARNING"
	| "MANUAL_REVIEW"
	| "BLOCKED"
	| "NOT_APPLICABLE";

export type Severity = "critical" | "high" | "medium" | "low" | "informational";

export interface Finding {
	file: string;
	line: number | null;
	evidence: string;
	detail: string;
	severity: Severity;
}

export interface CheckResult {
	id: string;
	title: string;
	status: Status;
	severity: Severity;
	rule: string | null;
	source: string | null;
	summary: string;
	reason: string | null;
	remediation: string | null;
	findings: Finding[];
	blocksRelease: boolean;
	attempts: number;
}

/**
 * The context a check receives. Typed loosely on purpose: the tests build a
 * minimal stand-in, and pinning every field here would make that harder without
 * making the checks safer.
 */
export type CheckContext = Record<string, unknown>;

export declare const STATUS: Readonly<Record<Status, Status>>;
export declare const SEVERITY_ORDER: readonly Severity[];
export declare const BLOCKING_STATUSES: readonly Status[];
export declare function result(input: Partial<CheckResult> & { id: string; title: string; status: Status }): CheckResult;
export declare function finding(input: Partial<Finding> & { file: string }): Finding;
export declare function highestSeverity(results: CheckResult[]): Severity;
export declare function countByStatus(results: CheckResult[]): Record<Status, number>;
