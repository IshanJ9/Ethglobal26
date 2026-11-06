// engine == spec/vectors/vectors.json (all case groups), mirroring spec/reference/verify-engine.mjs.
import { describe, expect, it } from "vitest";
import { specJson } from "../src/fixtures.ts";
import { bugCredit, carryBlend, curveInterp, payoutSplit, revision, tieredCommission, weightedScorecard } from "../src/engine/engine.ts";

const V = specJson("vectors/vectors.json");

describe("engine vs vectors.json", () => {
  it("curve_cases", () => {
    for (const c of V.curve_cases) expect(Number(curveInterp(V.payout_curve_default, c.score_bps))).toBe(c.multiplier_bps);
  });
  it("weighted_scorecard_cases", () => {
    for (const c of V.weighted_scorecard_cases) expect(weightedScorecard(c), c.name).toEqual(c.expected);
  });
  it("tiered_commission_cases", () => {
    for (const c of V.tiered_commission_cases) expect(tieredCommission(c), c.name).toEqual(c.expected);
  });
  it("bug_credit cases", () => {
    for (const c of V.bug_credit.cases) expect(bugCredit(c.fixes, V.bug_credit.policy), c.name).toEqual(c.expected);
  });
  it("payout_split_cases", () => {
    for (const c of V.payout_split_cases) expect(payoutSplit(c.target_bonus, c.multiplier_bps, c.holdback_bps)).toEqual(c.expected);
  });
  it("revision_cases", () => {
    for (const c of V.revision_cases) expect(revision(c.target_bonus, c.paid, c.held, c.new_multiplier_bps), c.name).toEqual(c.expected);
  });
  it("carry_forward_cases", () => {
    for (const c of V.carry_forward_cases) expect(carryBlend(c.cur_bps, c.prior_bps, c.w_bps)).toBe(c.blended_bps);
  });
  it("rejects bad inputs instead of dividing by zero or negatives", () => {
    expect(() => weightedScorecard({ kras: [{ kra_id: "x", direction: "higher_better", actual: 1, target: 0, floor_ppm: 0, cap_ppm: 1, weight_bps: 1 }], payout_curve: [[0, 0]] })).toThrow();
    expect(() => curveInterp([[0, 10], [100, 5]], 50)).toThrow();
  });
});
