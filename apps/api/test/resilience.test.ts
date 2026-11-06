// Chain failures and races: the DB never drifts from the chain, and a retry completes the work.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { MockChain } from "../src/chain/mock.ts";
import { ChainRevert, type ChainClient } from "../src/chain/types.ts";
import { expectNoViolations, login, TestClock, testApp } from "./helpers.ts";

/** MockChain whose named operations fail the next N times (simulates RPC/revert on testnet). */
function flakyChain(failures: Record<string, number>): ChainClient {
  const db = openDb(":memory:");
  const inner = new MockChain(db, new TestClock());
  return new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        const name = String(prop);
        if ((failures[name] ?? 0) > 0) {
          failures[name]--;
          throw new ChainRevert("simulated RPC failure", name);
        }
        return v.apply(target, args);
      };
    },
  }) as ChainClient;
}

const world = (a: any) => ({ adapter: "mock", payload: { action: a.world_action, signal: a.challenge, nullifier: "0x" + randomBytes(32).toString("hex") } });

async function approvedScorecard(app: any, steps: string[] = ["s1_collect_baseline", "s2_cosign_engagement"]) {
  const hr = await login(app, "p_hr");
  const mgr = await login(app, "p_eng_mgr");
  for (const step_id of steps) await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id } });
  const sc = (await app.inject({ method: "POST", url: "/v1/scorecards", headers: mgr, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" } })).json();
  const a = (await app.inject({ method: "POST", url: "/v1/approvals", headers: mgr, payload: { scorecard_id: sc.scorecard_id } })).json();
  await app.inject({ method: "POST", url: `/v1/approvals/${a.approval_id}/complete`, headers: mgr, payload: { decision: "approve", world_result: world(a) } });
  return { hr, mgr, sc };
}

describe("chain resilience", () => {
  it("registerPlan fails after attestScore landed: 502, DB records the attestation, release completes the registration", async () => {
    const app = await testApp({}, { chain: flakyChain({ registerPlan: 1 }) });
    const { mgr, sc } = await approvedScorecard(app);
    const at = await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: sc.scorecard_id } });
    expect(at.statusCode).toBe(502);
    expect(at.json().error).toMatchObject({ code: "chain_error", details: { op: "registerPlan", revert: "simulated RPC failure" } });
    // The attestation exists on chain AND in the DB: a retry must not try to attest again.
    expect((await app.inject({ method: "GET", url: `/v1/scorecards/${sc.scorecard_id}`, headers: mgr })).json().status).toBe("attested");
    expect((await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: sc.scorecard_id } })).statusCode).toBe(409);
    const rel = await app.inject({ method: "POST", url: `/v1/payouts/${sc.scorecard_id}/release`, headers: mgr });
    expect(rel.statusCode, rel.body).toBe(200);
    expect(rel.json()).toMatchObject({ status: "active", paid: "4000000000", held: "1000000000" });
    expectNoViolations(app);
  });

  it("applyRevision fails after v2 is attested: the next payout call applies it exactly once", async () => {
    const failures = { applyRevision: 1 };
    const app = await testApp({}, { chain: flakyChain(failures) });
    const { hr, mgr, sc: v1 } = await approvedScorecard(app);
    await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: v1.scorecard_id } });
    await app.inject({ method: "POST", url: `/v1/payouts/${v1.scorecard_id}/release`, headers: mgr });
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s3_revert_pr" } });
    const v2 = (await app.inject({ method: "POST", url: `/v1/scorecards/${v1.scorecard_id}/revise`, headers: mgr, payload: { reason: "revert" } })).json();
    const a = (await app.inject({ method: "POST", url: "/v1/approvals", headers: mgr, payload: { scorecard_id: v2.scorecard_id } })).json();
    await app.inject({ method: "POST", url: `/v1/approvals/${a.approval_id}/complete`, headers: mgr, payload: { decision: "approve", world_result: world(a) } });
    expect((await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: v2.scorecard_id } })).statusCode).toBe(502);
    expect((await app.inject({ method: "GET", url: `/v1/payouts/${v2.scorecard_id}`, headers: mgr })).json().forfeited).toBe("0");
    // A dispute (any payout op) settles first: the revision is applied, then the dispute goes through.
    const d = await app.inject({ method: "POST", url: `/v1/payouts/${v2.scorecard_id}/dispute`, headers: mgr, payload: { reason: "check" } });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({ status: "disputed", forfeited: "474000000", held: "526000000" });
    const actions = (await app.inject({ method: "GET", url: "/v1/audit?limit=200", headers: hr })).json().items.map((e: any) => e.action);
    expect(actions.filter((x: string) => x === "payout.revision_applied")).toHaveLength(1);
  });

  it("double click with different idempotency keys: one attest wins, the other gets 409", async () => {
    const app = await testApp();
    const { mgr, sc } = await approvedScorecard(app);
    const fire = (k: string) =>
      app.inject({ method: "POST", url: "/v1/chain/attest", headers: { ...mgr, "idempotency-key": k }, payload: { scorecard_id: sc.scorecard_id } });
    const [a, b] = await Promise.all([fire("click-aaaaaaaa"), fire("click-bbbbbbbb")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const anchors = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/v1/chain/anchor", headers: mgr })));
    expect(anchors.map((r) => r.statusCode).every((s) => s === 409 || s === 201)).toBe(true);
    expectNoViolations(app);
  });
});
