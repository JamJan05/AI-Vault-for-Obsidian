import type { CheckContext, CheckResult } from "../lib/model.d.mts";

/** Runs the actions compliance checks. Never throws for a policy violation — it reports one. */
export declare function run(ctx: CheckContext): Promise<CheckResult[]>;
