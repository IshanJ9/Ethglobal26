// /v1/scores/compute over the real ledger via /v1/dev/inject, against every `expect` in seed-scenario.json.
import { describe, expect, it } from "vitest";
import { seedScenario } from "../src/fixtures.ts";
import { CONNECTOR, expectNoViolations, login, testApp } from "./helpers.ts";

const S = seedScenario();
const PLAN: Record<string, string> = { emp_dev_a: "pln_eng_v1", emp_dev_b: "pln_eng_ic_v1", emp_dev_c: "pln_eng_ic_v1", emp_mkt_exec: "pln_mkt_v1", emp_ae: "pln_sales_v1" };

function summarize(r: any) {
  const o: any = { score_bps: r.score_bps, multiplier_bps: r.multiplier_bps, bonus_amount: r.bonus_amount, verified_ratio_bps: r.verified_ratio_bps, gate_passed: r.gate_passed };
  if (r.bug_credit) o.bug_credit_total_milli = r.bug_credit.total_milli;
  if (r.commission) o.commission = r.commission;
  if (r.carry_forward) {
    const { open_items, ...cf } = r.carry_forward;
    o.carry_forward = cf;
  }
  return o;
}

async function setup() {
  const app = await testApp();
  const hr = await login(app, "p_hr");
  const compute = async (emp: string, cyc: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/v1/scores/compute", headers: hr, payload: { plan_id: PLAN[emp], employee_id: emp, cycle_id: cyc, ...extra } });
  const inject = async (step: string) => {
    const r = await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: step } });
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  return { app, hr, compute, inject };
}

describe("scores/compute", () => {
  it("reproduces seed-scenario s1..s4 expectations through the API", async () => {
    const { app, compute, inject } = await setup();
    for (const st of S.steps) {
      await inject(st.step_id);
      for (const [key, exp] of Object.entries<any>(st.expect)) {
        const [emp, cyc] = key.split("@");
        if (cyc === "payout_revision") continue;
        if (st.step_id === "s4_cycle2_collect") {
          // Carry-forward needs cycle 1's final scorecard; scorecards arrive in Block 2, so stand one in.
          const prior = (await compute(emp, S.cycle_ids.c1)).json();
          app.svc.db
            .prepare(
              `INSERT INTO scorecards (scorecard_id, employee_id, cycle_id, version, status, result_json, evidence_ids_json, created_at)
               VALUES ('scd_test_prior', ?, ?, 1, 'attested', ?, '[]', '2027-01-02T00:00:00Z')`,
            )
            .run(emp, S.cycle_ids.c1, JSON.stringify(prior));
        }
        const r = await compute(emp, cyc);
        expect(r.statusCode, r.body).toBe(200);
        expect(summarize(r.json()), `${st.step_id} ${key}`).toEqual(exp);
      }
    }
    expectNoViolations(app);
  });

  it("n11: identical inputs give byte-identical output incl. inputs_hash", async () => {
    const { compute, inject } = await setup();
    await inject("s1_collect_baseline");
    const a = await compute("emp_dev_a", "cyc_2026h2");
    const b = await compute("emp_dev_a", "cyc_2026h2");
    expect(a.body).toBe(b.body);
    expect(a.json().inputs_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("n09: unverified evidence is not counted; verified_ratio drops", async () => {
    const { app, compute, inject } = await setup();
    await inject("s1_collect_baseline");
    const before = (await compute("emp_dev_a", "cyc_2026h2")).json();
    await app.inject({
      method: "POST",
      url: "/v1/evidence/ingest",
      headers: CONNECTOR,
      payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2", source: "worklog", kind: "daily_log", ref: "wl:n09", observed_at: "2026-12-10T00:00:00Z", observations: [{ metric_key: "deliverables", value: 5 }] },
    });
    const after = (await compute("emp_dev_a", "cyc_2026h2")).json();
    expect(after.lines.find((l: any) => l.kra_id === "deliverables").actual).toBe(before.lines.find((l: any) => l.kra_id === "deliverables").actual);
    expect(after.verified_ratio_bps).toBeLessThan(before.verified_ratio_bps);
    expect(after.inputs_hash).not.toBe(before.inputs_hash);
  });

  it("n10: gate fails with too much unverified evidence -> zero payout", async () => {
    const { app, compute, inject } = await setup();
    await inject("s1_collect_baseline");
    for (let i = 0; i < 6; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/evidence/ingest",
        headers: CONNECTOR,
        payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2", source: "worklog", kind: "daily_log", ref: `wl:n10:${i}`, observed_at: "2026-12-10T00:00:00Z", observations: [] },
      });
    }
    const r = (await compute("emp_dev_a", "cyc_2026h2")).json();
    expect(r).toMatchObject({ gate_passed: false, multiplier_bps: 0, bonus_amount: "0" });
  });

  it("as_of filters evidence; override_actuals is a sandbox (unknown kra -> 400)", async () => {
    const { compute, inject } = await setup();
    await inject("s1_collect_baseline");
    const early = (await compute("emp_dev_a", "cyc_2026h2", { as_of: "2026-07-02T00:00:00Z" })).json();
    expect(early.lines.every((l: any) => l.actual === 0 || l.kra_id === "service_cfr")).toBe(true);
    const what = (await compute("emp_dev_a", "cyc_2026h2", { override_actuals: { deliverables: 20 } })).json();
    expect(what.lines.find((l: any) => l.kra_id === "deliverables").actual).toBe(20);
    expect(what.warnings.join(" ")).toMatch(/override_actuals/);
    const bad = await compute("emp_dev_a", "cyc_2026h2", { override_actuals: { nope: 1 } });
    expect(bad.statusCode).toBe(400);
  });

  it("an employee cannot compute someone else's score (404)", async () => {
    const { app } = await setup();
    const r = await app.inject({
      method: "POST",
      url: "/v1/scores/compute",
      headers: await login(app, "p_dev_b"),
      payload: { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" },
    });
    expect(r.statusCode).toBe(404);
  });
});
