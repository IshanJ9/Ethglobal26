// For each step in seed-scenario.json, the ported engine reproduces `expect`, using the same
// accumulation rules as scripts/gen-fixtures.mjs; the port also equals the JS reference byte for byte.
import { describe, expect, it } from "vitest";
import { seedScenario, specJson } from "../src/fixtures.ts";
import { evaluateCommission, evaluatePlan, payoutSplit, revision, type EngineEvidence } from "../src/engine/engine.ts";
import { expandEvent } from "../src/dev/expand.ts";
// @ts-expect-error - plain JS reference modules (no types)
import * as ref from "../../../spec/reference/engine.mjs";
// @ts-expect-error - plain JS reference module (no types)
import { expandEvent as refExpand } from "../../../spec/reference/expand.mjs";

const CONNECTOR = new Set(["github", "tickets", "crm", "hris"]);
const S = seedScenario();
const org = specJson("fixtures/seed-org.json");
const planOf = (emp: string) => specJson(`fixtures/plans/${org.employees.find((e: any) => e.employee_id === emp).plan_id}.json`);

function summarize(r: any) {
  const o: any = {
    score_bps: r.score_bps,
    multiplier_bps: r.multiplier_bps,
    bonus_amount: r.bonus_amount,
    verified_ratio_bps: r.verified_ratio_bps,
    gate_passed: r.gate_passed,
  };
  if (r.bug_credit) o.bug_credit_total_milli = r.bug_credit.total_milli;
  if (r.commission) o.commission = r.commission;
  if (r.carry_forward) o.carry_forward = r.carry_forward;
  return o;
}

describe("seed-scenario expectations", () => {
  it("expandEvent port equals the reference for every event", () => {
    for (const st of S.steps) for (const e of st.events) expect(expandEvent(e)).toEqual(refExpand(e));
  });

  it("every step's expect block is reproduced (and port == reference)", () => {
    const state: Array<EngineEvidence & { employee_id: string; cycle_id: string; ref: string }> = [];
    let seq = 0;
    const finals: Record<string, number> = {};
    for (const st of S.steps) {
      for (const raw of st.events) {
        for (const e of expandEvent(raw)) {
          seq++;
          const status = CONNECTOR.has(e.source) || e.source === "cosign" ? "verified" : "unverified";
          if (e.reverts_ref) state.find((s) => s.ref === e.reverts_ref)!.status = "reverted";
          state.push({ evidence_id: `evd_${String(seq).padStart(4, "0")}`, ...e, status });
        }
      }
      for (const [key, exp] of Object.entries<any>(st.expect)) {
        const [emp, cyc] = key.split("@");
        if (cyc === "payout_revision") continue;
        const plan = planOf(emp);
        const items = state.filter((x) => x.employee_id === emp && x.cycle_id === cyc);
        const prior = cyc === S.cycle_ids.c2 ? (finals[`${emp}@${S.cycle_ids.c1}`] ?? null) : null;
        const mine = plan.kind === "tiered_commission" ? evaluateCommission(plan, items) : evaluatePlan(plan, items, { priorBps: prior });
        const theirs = plan.kind === "tiered_commission" ? ref.evaluateCommission(plan, items) : ref.evaluatePlan(plan, items, { priorBps: prior });
        expect(JSON.stringify(mine), `${st.step_id} ${key} port==reference`).toBe(JSON.stringify(theirs));
        expect(summarize(mine), `${st.step_id} ${key}`).toEqual(exp);
        finals[key] = mine.score_bps;
      }
      const rev = st.expect["emp_dev_a@payout_revision"];
      if (rev) {
        const plan = planOf("emp_dev_a");
        const v1 = S.steps[1].expect["emp_dev_a@cyc_2026h2"];
        const v2 = st.expect["emp_dev_a@cyc_2026h2"];
        const split = payoutSplit(plan.target_bonus, v1.multiplier_bps, plan.holdback_bps);
        expect(split).toEqual(rev.v1_split);
        expect(revision(plan.target_bonus, split.immediate, split.held, v2.multiplier_bps)).toEqual(rev.revision);
      }
    }
  });
});
