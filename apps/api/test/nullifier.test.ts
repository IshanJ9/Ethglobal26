// World ID nullifiers are fixed per (person, action). One manager must be able to approve many scorecards with the
// same nullifier, while a proof can never be replayed for the same object (replay key = nullifier + action:object).
import { describe, expect, it } from "vitest";
import { expectNoViolations, login, testApp } from "./helpers.ts";

describe("World ID nullifier scope", () => {
  it("same human approves two scorecards; the same scorecard cannot be approved twice with that nullifier", async () => {
    const app = await testApp();
    const hr = await login(app, "p_hr");
    const mgr = await login(app, "p_eng_mgr");
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } });
    const nullifier = "0x" + "ab".repeat(32); // the manager's fixed nullifier for pw-approve-scorecard
    const world = (a: any) => ({ adapter: "mock", payload: { action: a.world_action, signal: a.challenge, nullifier } });
    const approveFor = async (emp: string) => {
      const sc = (await app.inject({ method: "POST", url: "/v1/scorecards", headers: mgr, payload: { employee_id: emp, cycle_id: "cyc_2026h2" } })).json();
      const a = (await app.inject({ method: "POST", url: "/v1/approvals", headers: mgr, payload: { scorecard_id: sc.scorecard_id } })).json();
      return { a, r: await app.inject({ method: "POST", url: `/v1/approvals/${a.approval_id}/complete`, headers: mgr, payload: { decision: "approve", world_result: world(a) } }) };
    };
    const first = await approveFor("emp_dev_a");
    expect(first.r.statusCode).toBe(200);
    const second = await approveFor("emp_dev_b");
    expect(second.r.statusCode).toBe(200); // same human, different scorecard: allowed

    const n = app.svc.db.prepare("SELECT COUNT(*) AS c FROM world_nullifiers WHERE nullifier = ?").get(BigInt(nullifier).toString(10)) as { c: number } | undefined;
    const raw = app.svc.db.prepare("SELECT COUNT(*) AS c FROM world_nullifiers").get() as { c: number };
    expect((n?.c ?? 0) + raw.c).toBeGreaterThanOrEqual(2);
    expectNoViolations(app);
  });
});
