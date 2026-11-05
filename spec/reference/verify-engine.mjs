// Runs every scoring vector through the JS reference engine and compares with the Python-generated expectations.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { bugCredit, carryBlend, curveInterp, payoutSplit, revision, tieredCommission, weightedScorecard } from "./engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const V = JSON.parse(readFileSync(join(here, "../vectors/vectors.json"), "utf8"));
let n = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

for (const c of V.curve_cases) eq(Number(curveInterp(V.payout_curve_default, c.score_bps)), c.multiplier_bps, `curve ${c.score_bps}`);
for (const c of V.weighted_scorecard_cases) eq(weightedScorecard(c), c.expected, c.name);
for (const c of V.tiered_commission_cases) eq(tieredCommission(c), c.expected, c.name);
for (const c of V.bug_credit.cases) eq(bugCredit(c.fixes, V.bug_credit.policy), c.expected, c.name);
for (const c of V.payout_split_cases) eq(payoutSplit(c.target_bonus, c.multiplier_bps, c.holdback_bps), c.expected, "split");
for (const c of V.revision_cases) eq(revision(c.target_bonus, c.paid, c.held, c.new_multiplier_bps), c.expected, c.name);
for (const c of V.carry_forward_cases) eq(carryBlend(c.cur_bps, c.prior_bps, c.w_bps), c.blended_bps, "carry");
console.log(`engine vectors OK (${n} assertions)`);
