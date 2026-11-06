import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expectNoViolations, login, TestClock, testApp } from "./helpers.ts";

const world = (a: any, nullifier = "0x" + randomBytes(32).toString("hex")) => ({ adapter: "mock", payload: { action: a.world_action, signal: a.challenge, nullifier } });

async function setup(clock = new TestClock()) {
  const app = await testApp({}, { clock });
  const hr = await login(app, "p_hr");
  const mgr = await login(app, "p_eng_mgr");
  const asha = await login(app, "p_dev_a");
  await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } });
  const sc = async (emp = "emp_dev_a", h = mgr) => (await app.inject({ method: "POST", url: "/v1/scorecards", headers: h, payload: { employee_id: emp, cycle_id: "cyc_2026h2" } })).json();
  const approval = async (id: string, h = mgr) => app.inject({ method: "POST", url: "/v1/approvals", headers: h, payload: { scorecard_id: id } });
  const complete = async (id: string, body: unknown, h = mgr) => app.inject({ method: "POST", url: `/v1/approvals/${id}/complete`, headers: h, payload: body as any });
  return { app, clock, hr, mgr, asha, sc, approval, complete };
}

describe("scorecards + approvals", () => {
  it("scorecard v1: evidence root, commitment, subject pseudonym, versioning", async () => {
    const { app, sc } = await setup();
    const v1 = await sc();
    expect(v1).toMatchObject({ version: 1, status: "draft", needs_revision: false, attestation: null, supersedes_scorecard_id: null });
    expect(v1.result.score_bps).toBe(8571);
    expect(v1.subject_id).toMatch(/^0x[0-9a-f]{64}$/);
    const obj = app.svc.scorecardSvc.reveal(v1.scorecard_id)!.value as any;
    expect(obj.employee_ref).toBe(v1.subject_id);
    expect(JSON.stringify(obj)).not.toContain("Asha");
    expect((await sc()).version).toBe(2);
    expectNoViolations(app);
  });

  it("422 when there is no counted evidence", async () => {
    const { app, mgr } = await setup();
    const r = await app.inject({ method: "POST", url: "/v1/scorecards", headers: mgr, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2027h1" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("n01: the employee cannot approve their own scorecard (403)", async () => {
    const { app, sc, approval, complete, asha, mgr } = await setup();
    const v1 = await sc("emp_dev_a", asha);
    const own = await approval(v1.scorecard_id, asha);
    expect(own.statusCode).toBe(403);
    expect(own.json().error.code).toBe("forbidden");
    const a = (await approval(v1.scorecard_id, mgr)).json();
    const r = await complete(a.approval_id, { decision: "approve", world_result: world(a) }, asha);
    expect(r.statusCode).toBe(403);
    expectNoViolations(app);
  });

  it("n03: approve without world_result -> 401, approval stays pending", async () => {
    const { app, sc, approval, complete, mgr } = await setup();
    const a = (await approval((await sc()).scorecard_id)).json();
    expect(a.world_action).toBe(`pw-approve-scorecard-${a.scorecard_id}`); // one World action per scorecard (CR-006)
    const r = await complete(a.approval_id, { decision: "approve" });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("world_verification_failed");
    const wrongSignal = await complete(a.approval_id, { decision: "approve", world_result: { adapter: "mock", payload: { action: a.world_action, signal: "0x" + "1".repeat(64), nullifier: "0x" + "2".repeat(64) } } });
    expect(wrongSignal.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/v1/approvals/${a.approval_id}`, headers: mgr })).json().status).toBe("pending");
  });

  it("n04: a World proof cannot be replayed on a second approval", async () => {
    const { app, sc, approval, complete } = await setup();
    const a = (await approval((await sc("emp_dev_a")).scorecard_id)).json();
    const proof = world(a);
    const ok = await complete(a.approval_id, { decision: "approve", world_result: proof });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "approved", approver_employee_id: "emp_eng_mgr" });
    expect(ok.json().approval_proof_hash).toMatch(/^0x[0-9a-f]{64}$/);
    const b = (await approval((await sc("emp_dev_b")).scorecard_id)).json();
    const replay = await complete(b.approval_id, { decision: "approve", world_result: proof }); // bound to a.challenge
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("world_verification_failed");
    // Only a hash of the World result is stored.
    expect(JSON.stringify(app.svc.db.prepare("SELECT * FROM approvals").all())).not.toContain(proof.payload.nullifier);
    expectNoViolations(app);
  });

  it("n02: deny is final and blocks attest and payout", async () => {
    const { app, sc, approval, complete, mgr } = await setup();
    const v1 = await sc();
    const a = (await approval(v1.scorecard_id)).json();
    const d = await complete(a.approval_id, { decision: "deny", comment: "evidence incomplete" });
    expect(d.json().status).toBe("denied");
    expect((await complete(a.approval_id, { decision: "approve", world_result: world(a) })).statusCode).toBe(409);
    const at = await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: v1.scorecard_id } });
    expect(at.statusCode).toBe(409);
    expect(at.json().error.code).toBe("approval_required");
    const pay = await app.inject({ method: "POST", url: `/v1/payouts/${v1.scorecard_id}/release`, headers: mgr });
    expect(pay.statusCode).toBe(409);
    expectNoViolations(app);
  });

  it("attest without any approval -> 409 approval_required; cancel returns the scorecard to draft", async () => {
    const { app, sc, approval, mgr } = await setup();
    const v1 = await sc();
    const r = await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: v1.scorecard_id } });
    expect(r.json().error.code).toBe("approval_required");
    const a = (await approval(v1.scorecard_id)).json();
    expect((await app.inject({ method: "GET", url: `/v1/scorecards/${v1.scorecard_id}`, headers: mgr })).json().status).toBe("pending_approval");
    const c = await app.inject({ method: "POST", url: `/v1/approvals/${a.approval_id}/cancel`, headers: mgr });
    expect(c.json().status).toBe("cancelled");
    expect((await app.inject({ method: "GET", url: `/v1/scorecards/${v1.scorecard_id}`, headers: mgr })).json().status).toBe("draft");
  });

  it("payouts: holdback before maturity is 409, after maturity pays and vests evidence; dispute/resolve", async () => {
    const clock = new TestClock();
    const { app, sc, approval, complete, mgr, hr, asha } = await setup(clock);
    const approveAndAttest = async (emp: string) => {
      const v = await sc(emp);
      const a = (await approval(v.scorecard_id)).json();
      await complete(a.approval_id, { decision: "approve", world_result: world(a) });
      const at = await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: v.scorecard_id } });
      expect(at.statusCode, at.body).toBe(201);
      expect((await app.inject({ method: "POST", url: `/v1/payouts/${v.scorecard_id}/release`, headers: mgr })).statusCode).toBe(200);
      return v;
    };
    const v = await approveAndAttest("emp_dev_a");
    expect((await app.inject({ method: "POST", url: `/v1/payouts/${v.scorecard_id}/release`, headers: mgr })).statusCode).toBe(409);
    const early = await app.inject({ method: "POST", url: `/v1/payouts/${v.scorecard_id}/release-holdback`, headers: mgr });
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error.details?.maturity_at, early.body).toBeTruthy();
    clock.advance(91 * 86400_000);
    const hb = (await app.inject({ method: "POST", url: `/v1/payouts/${v.scorecard_id}/release-holdback`, headers: mgr })).json();
    expect(hb).toMatchObject({ status: "closed", paid: "4463500000", held: "0" });
    expect(app.svc.ledger.get(v.evidence_ids[0])!.status).toBe("vested");

    const w = await approveAndAttest("emp_dev_b");
    const disp = await app.inject({ method: "POST", url: `/v1/payouts/${w.scorecard_id}/dispute`, headers: mgr, payload: { reason: "client complaint" } });
    expect(disp.json().status).toBe("disputed");
    expect((await app.inject({ method: "POST", url: `/v1/payouts/${w.scorecard_id}/resolve`, headers: mgr, payload: { release_funds: false } })).statusCode).toBe(403);
    const res = (await app.inject({ method: "POST", url: `/v1/payouts/${w.scorecard_id}/resolve`, headers: hr, payload: { release_funds: false } })).json();
    expect(res).toMatchObject({ status: "closed", held: "0", forfeited: "600000000" }); // CR-004: Ben is on the IC plan (3,000 USDC target, 20% held)
    // The employee can read their own payout but not trigger a release.
    expect((await app.inject({ method: "GET", url: `/v1/payouts/${v.scorecard_id}`, headers: asha })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/payouts/${v.scorecard_id}/release`, headers: asha })).statusCode).toBe(403);
    expectNoViolations(app);
  });

  it("runs: agent ingests via deterministic connectors, idempotent on re-run", async () => {
    const { app, mgr } = await setup();
    const start = await app.inject({ method: "POST", url: "/v1/runs", headers: mgr, payload: { employee_id: "emp_dev_c", cycle_id: "cyc_2026h2" } });
    expect(start.statusCode).toBe(202);
    await app.svc.runs.wait(start.json().run_id);
    const run = (await app.inject({ method: "GET", url: `/v1/runs/${start.json().run_id}`, headers: mgr })).json();
    expect(run.status).toBe("succeeded");
    expect(run.tool_calls.map((t: any) => t.tool)).toEqual(["git", "tickets", "crm", "hris", "worklog"]);
    expect(run.agent_identity).toMatchObject({ ens_name: "kra-agent", agent_pass: "mock" });
    expect(run.tool_calls.every((t: any) => /already in ledger/.test(t.note))).toBe(true); // s1 already injected
    expect((await app.inject({ method: "GET", url: `/v1/runs/${run.run_id}`, headers: await login(app, "p_dev_a") })).statusCode).toBe(404);
    expectNoViolations(app);
  });
});
