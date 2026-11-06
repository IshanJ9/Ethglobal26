import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keccakUtf8 } from "@proofwork/crypto";
import { LocalReplicaStore, type ReplicaStore } from "../src/replica/replica.ts";
import { LiveWorldVerifier, signalHashes } from "../src/world/verifier.ts";
import { CONNECTOR, expectNoViolations, login, testApp } from "./helpers.ts";

const ev = (ref: string) => ({
  employee_id: "emp_dev_a",
  cycle_id: "cyc_2026h2",
  source: "github",
  kind: "pr_merged",
  ref,
  observed_at: "2026-12-05T10:00:00Z",
  observations: [{ metric_key: "deliverables", value: 1 }],
  raw: { title: "secret-ish raw payload" },
});

describe("Idempotency-Key", () => {
  it("replays the first response; same key + different body -> 409; no key -> acts twice", async () => {
    const app = await testApp();
    const hr = await login(app, "p_hr");
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } });
    const mgr = await login(app, "p_eng_mgr");
    const h = { ...mgr, "idempotency-key": "click-0001-abcdef" };
    const a = await app.inject({ method: "POST", url: "/v1/scorecards", headers: h, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" } });
    const b = await app.inject({ method: "POST", url: "/v1/scorecards", headers: h, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" } });
    expect(b.statusCode).toBe(201);
    expect(b.body).toBe(a.body);
    expect(b.headers["idempotent-replay"]).toBe("true");
    const c = await app.inject({ method: "POST", url: "/v1/scorecards", headers: h, payload: { employee_id: "emp_dev_b", cycle_id: "cyc_2026h2" } });
    expect(c.statusCode).toBe(409);
    const list = (await app.inject({ method: "GET", url: "/v1/scorecards?employee_id=emp_dev_a", headers: mgr })).json().items;
    expect(list).toHaveLength(1);
    // Keys are scoped per caller.
    const other = await app.inject({ method: "POST", url: "/v1/scorecards", headers: { ...hr, "idempotency-key": "click-0001-abcdef" }, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" } });
    expect(other.json().version).toBe(2);
    expect((await app.inject({ method: "POST", url: "/v1/scorecards", headers: { ...mgr, "idempotency-key": "x" }, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" } })).statusCode).toBe(400);
    expectNoViolations(app);
  });
});

describe("rate limits", () => {
  it("429 rate_limited with the Error shape", async () => {
    const app = await testApp({ RATE_LIMIT_PER_MIN: "5" });
    let last: any;
    for (let i = 0; i < 7; i++) last = await app.inject({ method: "GET", url: "/healthz" });
    expect(last.statusCode).toBe(429);
    expect(last.json().error.code).toBe("rate_limited");
    expect(last.headers["x-spec-version"]).toBe("1.0.0");
  });
});

describe("replica store", () => {
  it("stores the ENCRYPTED payload (pending -> stored); shred deletes the local copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-replica-"));
    const app = await testApp({}, { replica: new LocalReplicaStore(dir) });
    const r = await app.inject({ method: "POST", url: "/v1/evidence/ingest", headers: CONNECTOR, payload: ev("gh:r#1") });
    expect(r.json().replica.status).toBe("pending");
    await app.svc.replica.flush();
    const item = app.svc.ledger.get(r.json().evidence_id)!;
    expect(item.replica!.status).toBe("stored");
    const file = join(dir, `${item.replica!.zg_root}.bin`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("secret-ish");
    await app.inject({ method: "POST", url: `/v1/evidence/${item.evidence_id}/shred`, headers: await login(app, "p_hr") });
    await new Promise((res) => setTimeout(res, 20));
    expect(existsSync(file)).toBe(false);
    expect(app.svc.ledger.get(item.evidence_id)!.replica).toEqual({ zg_root: null, status: "shredded" });
    expectNoViolations(app);
  });

  it("a failing replica never blocks ingest", async () => {
    const failing: ReplicaStore = { mode: "live", put: async () => Promise.reject(new Error("0G down")), forget: async () => {} };
    const app = await testApp({}, { replica: failing });
    const r = await app.inject({ method: "POST", url: "/v1/evidence/ingest", headers: CONNECTOR, payload: ev("gh:r#2") });
    expect(r.statusCode).toBe(201);
    await app.svc.replica.flush();
    expect(app.svc.ledger.get(r.json().evidence_id)!.replica!.status).toBe("failed");
  });
});

describe("live WorldVerifier (fake portal)", () => {
  const signal = keccakUtf8("challenge");
  const sigHash = [...signalHashes(signal)].pop()!;
  const proof = (over: Record<string, unknown> = {}) => ({
    adapter: "idkit" as const,
    payload: { protocol_version: "4.0", nonce: "n", action: "pw-approve-scorecard", environment: "production", responses: [{ identifier: "orb", nullifier: "0x" + "ab".repeat(32), signal_hash: sigHash, proof: ["0x1", "0x2", "0x3", "0x4", "0x5"] }], ...over },
  });
  const portal = (status: number, body: unknown) => {
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it("forwards the IDKit payload to /api/v4/verify/{rp_id} and returns a normalized nullifier", async () => {
    const p = portal(200, { success: true, environment: "production", results: [{ identifier: "orb", success: true, nullifier: "0x" + "ab".repeat(32) }] });
    const v = new LiveWorldVerifier("rp_test", { fetchImpl: p.fetchImpl });
    const r = await v.verify({ action: "pw-approve-scorecard", signal, result: proof() });
    expect(r).toEqual({ ok: true, nullifier: BigInt("0x" + "ab".repeat(32)).toString(10) });
    expect(p.calls[0].url).toBe("https://developer.world.org/api/v4/verify/rp_test");
    expect(p.calls[0].body.action).toBe("pw-approve-scorecard");
  });

  it("rejects wrong action, wrong signal, staging env, agent_pass, mock adapter and portal failure without calling out when it can", async () => {
    const p = portal(400, { success: false, code: "all_verifications_failed" });
    const v = new LiveWorldVerifier("rp_test", { fetchImpl: p.fetchImpl });
    const bad = async (result: any, sig = signal) => (await v.verify({ action: "pw-approve-scorecard", signal: sig, result })) as any;
    expect((await bad(proof({ action: "other" }))).reason).toMatch(/action/);
    expect((await bad(proof(), keccakUtf8("another challenge"))).reason).toMatch(/signal/);
    expect((await bad(proof({ environment: "staging" }))).reason).toMatch(/environment/);
    expect((await bad({ adapter: "agent_pass", payload: {} })).reason).toMatch(/U1/);
    expect((await bad({ adapter: "mock", payload: {} })).ok).toBe(false);
    expect(p.calls).toHaveLength(0);
    expect((await bad(proof())).reason).toMatch(/portal 400/);
  });

  it("signal hash = keccak256(signal) >> 8, both UTF-8 and bytes interpretations of a hex signal", () => {
    const hs = signalHashes("0x1234");
    expect(hs.size).toBe(2);
    for (const h of hs) expect(BigInt(h) < 2n ** 248n).toBe(true);
  });
});

describe("carry-forward edge cases", () => {
  async function cycle1Final(app: any, opts: { attest: boolean }) {
    const hr = await login(app, "p_hr");
    const mgr = await login(app, "p_eng_mgr");
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } });
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s4_cycle2_collect" } });
    const v1 = (await app.inject({ method: "POST", url: "/v1/scorecards", headers: mgr, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" } })).json();
    const a = (await app.inject({ method: "POST", url: "/v1/approvals", headers: mgr, payload: { scorecard_id: v1.scorecard_id } })).json();
    await app.inject({
      method: "POST",
      url: `/v1/approvals/${a.approval_id}/complete`,
      headers: mgr,
      payload: { decision: "approve", world_result: { adapter: "mock", payload: { action: a.world_action, signal: a.challenge, nullifier: "0x" + randomBytes(32).toString("hex") } } },
    });
    if (opts.attest) await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: v1.scorecard_id } });
    const compute = async () =>
      (await app.inject({ method: "POST", url: "/v1/scores/compute", headers: mgr, payload: { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: "cyc_2027h1" } })).json();
    return { hr, mgr, v1, compute };
  }

  it("no prior final scorecard -> no carry_forward; cycle 1 never has a prior", async () => {
    const app = await testApp();
    const hr = await login(app, "p_hr");
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s4_cycle2_collect" } });
    const r = (await app.inject({ method: "POST", url: "/v1/scores/compute", headers: hr, payload: { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: "cyc_2027h1" } })).json();
    expect(r.carry_forward).toBeUndefined();
    expect(r.score_bps).toBe(8143); // raw cycle-2 score, unblended
  });

  it("an approved (not yet attested) prior counts; a draft does not", async () => {
    const app = await testApp();
    const { compute } = await cycle1Final(app, { attest: false });
    expect((await compute()).carry_forward.prior_score_bps).toBe(8571);
  });

  it("prior superseded by a revision -> the revised version is used; reverted prior evidence is an open item", async () => {
    const app = await testApp();
    const { hr, mgr, v1, compute } = await cycle1Final(app, { attest: true });
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s3_revert_pr" } });
    const v2 = (await app.inject({ method: "POST", url: `/v1/scorecards/${v1.scorecard_id}/revise`, headers: mgr, payload: { reason: "revert" } })).json();
    const draftOnly = await compute();
    expect(draftOnly.carry_forward.prior_score_bps).toBe(8571); // v2 still draft: v1 attested is the final
    expect(draftOnly.carry_forward.open_items).toHaveLength(1);
    const a = (await app.inject({ method: "POST", url: "/v1/approvals", headers: mgr, payload: { scorecard_id: v2.scorecard_id } })).json();
    await app.inject({
      method: "POST",
      url: `/v1/approvals/${a.approval_id}/complete`,
      headers: mgr,
      payload: { decision: "approve", world_result: { adapter: "mock", payload: { action: a.world_action, signal: a.challenge, nullifier: "0x" + randomBytes(32).toString("hex") } } },
    });
    await app.inject({ method: "POST", url: "/v1/chain/attest", headers: mgr, payload: { scorecard_id: v2.scorecard_id } });
    const after = await compute();
    expect(after.carry_forward.prior_score_bps).toBe(v2.result.score_bps);
    expect((await app.inject({ method: "GET", url: `/v1/scorecards/${v1.scorecard_id}`, headers: mgr })).json().status).toBe("superseded");
  });

  it("a denied prior is ignored", async () => {
    const app = await testApp();
    const hr = await login(app, "p_hr");
    const mgr = await login(app, "p_eng_mgr");
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } });
    await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s4_cycle2_collect" } });
    const v1 = (await app.inject({ method: "POST", url: "/v1/scorecards", headers: mgr, payload: { employee_id: "emp_dev_a", cycle_id: "cyc_2026h2" } })).json();
    const a = (await app.inject({ method: "POST", url: "/v1/approvals", headers: mgr, payload: { scorecard_id: v1.scorecard_id } })).json();
    await app.inject({ method: "POST", url: `/v1/approvals/${a.approval_id}/complete`, headers: mgr, payload: { decision: "deny" } });
    const r = (await app.inject({ method: "POST", url: "/v1/scores/compute", headers: mgr, payload: { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: "cyc_2027h1" } })).json();
    expect(r.carry_forward).toBeUndefined();
  });
});
