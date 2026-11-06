// n01-n18 from spec/fixtures/seed-scenario.json `negative_tests`, end to end through the HTTP API.
// Each test is named after its id; the final test asserts every id in the fixture is covered here.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { toClaimMessage } from "@proofwork/crypto";
import { seedScenario } from "../src/fixtures.ts";
import { CONNECTOR, expectNoViolations, login, personaAccount, testApp } from "./helpers.ts";

const S = seedScenario();
const NEG = Object.fromEntries((S.negative_tests as any[]).map((n) => [n.id, n.expect]));
const C1 = "cyc_2026h2";
const CFO = personaAccount("p_client_cfo");
const covered = new Set<string>();
const nid = (id: string) => {
  covered.add(id);
  return id;
};

type H = Record<string, string>;
interface Ctx {
  app: FastifyInstance;
  hr: H;
  mgr: H;
  asha: H;
  call: (method: string, url: string, h?: H, payload?: unknown) => Promise<{ status: number; json: any; body: string }>;
}

async function setup(inject = true): Promise<Ctx> {
  const app = await testApp();
  const call = async (method: string, url: string, h: H = {}, payload?: unknown) => {
    const r = await app.inject({ method: method as any, url, headers: h, ...(payload !== undefined ? { payload: payload as any } : {}) });
    return { status: r.statusCode, json: r.body ? r.json() : null, body: r.body };
  };
  const hr = await login(app, "p_hr");
  if (inject) await call("POST", "/v1/dev/inject", hr, { step_id: "s1_collect_baseline" });
  return { app, hr, mgr: await login(app, "p_eng_mgr"), asha: await login(app, "p_dev_a"), call };
}

const world = (a: any) => ({ adapter: "mock", payload: { action: a.world_action, signal: a.challenge, nullifier: "0x" + randomBytes(32).toString("hex") } });
const expectError = (r: { status: number; json: any }, e: { http: number; code?: string }) => {
  expect(r.status).toBe(e.http);
  if (e.code) expect(r.json.error.code).toBe(e.code);
};

async function scorecard(c: Ctx, emp = "emp_dev_a") {
  return (await c.call("POST", "/v1/scorecards", c.mgr, { employee_id: emp, cycle_id: C1 })).json;
}
async function approved(c: Ctx, emp = "emp_dev_a") {
  const sc = await scorecard(c, emp);
  const a = (await c.call("POST", "/v1/approvals", c.mgr, { scorecard_id: sc.scorecard_id })).json;
  expect((await c.call("POST", `/v1/approvals/${a.approval_id}/complete`, c.mgr, { decision: "approve", world_result: world(a) })).status).toBe(200);
  return sc;
}
const sign = (who: ReturnType<typeof personaAccount>, td: any, domainOverride: Record<string, unknown> = {}) =>
  who.signTypedData({ domain: { ...td.domain, ...domainOverride }, types: td.types, primaryType: "Claim", message: toClaimMessage(td.message) as any });

/** Claim up to the requested stage; returns ids, package and co-sign token. */
async function claim(c: Ctx, stage: "drafted" | "packaged" | "granted") {
  const sc = S.scripted_claims[0];
  const cl = (await c.call("POST", "/v1/claims", c.asha, { cycle_id: C1, kra_id: sc.kra_id, raw_text: sc.raw_text, cosigner_address: CFO.address, cosigner_label: "Acme Bank CFO" })).json;
  if (stage === "drafted") return { cl };
  const pkg = (await c.call("GET", `/v1/claims/${cl.claim_id}/signing-package`, c.asha)).json;
  if (stage === "packaged") return { cl, pkg };
  expect((await c.call("POST", `/v1/claims/${cl.claim_id}/submit`, c.asha, { employee_signature: await sign(personaAccount("p_dev_a"), pkg.typed_data) })).status).toBe(200);
  const g = (await c.call("POST", `/v1/claims/${cl.claim_id}/cosign-grants`, c.asha, { auth_method: "magic_link_wallet" })).json;
  return { cl, pkg, tok: { "x-cosign-token": g.token } };
}

describe("negative tests n01-n18 (seed-scenario.json)", () => {
  it(nid("n01_self_approval"), async () => {
    const c = await setup();
    const sc = (await c.call("POST", "/v1/scorecards", c.asha, { employee_id: "emp_dev_a", cycle_id: C1 })).json;
    expectError(await c.call("POST", "/v1/approvals", c.asha, { scorecard_id: sc.scorecard_id }), NEG.n01_self_approval);
    const a = (await c.call("POST", "/v1/approvals", c.mgr, { scorecard_id: sc.scorecard_id })).json;
    expectError(await c.call("POST", `/v1/approvals/${a.approval_id}/complete`, c.asha, { decision: "approve", world_result: world(a) }), NEG.n01_self_approval);
    expectNoViolations(c.app);
  });

  it(nid("n02_approval_denied_blocks_attest"), async () => {
    const c = await setup();
    const sc = await scorecard(c);
    const a = (await c.call("POST", "/v1/approvals", c.mgr, { scorecard_id: sc.scorecard_id })).json;
    await c.call("POST", `/v1/approvals/${a.approval_id}/complete`, c.mgr, { decision: "deny" });
    expectError(await c.call("POST", "/v1/chain/attest", c.mgr, { scorecard_id: sc.scorecard_id }), NEG.n02_approval_denied_blocks_attest);
    expect((await c.call("POST", `/v1/payouts/${sc.scorecard_id}/release`, c.mgr)).status).toBe(409);
    expectNoViolations(c.app);
  });

  it(nid("n03_world_proof_missing"), async () => {
    const c = await setup();
    const sc = await scorecard(c);
    const a = (await c.call("POST", "/v1/approvals", c.mgr, { scorecard_id: sc.scorecard_id })).json;
    expectError(await c.call("POST", `/v1/approvals/${a.approval_id}/complete`, c.mgr, { decision: "approve" }), NEG.n03_world_proof_missing);
    expect((await c.call("GET", `/v1/approvals/${a.approval_id}`, c.mgr)).json.status).toBe("pending");
  });

  it(nid("n04_world_proof_replayed"), async () => {
    const c = await setup();
    const a1 = (await c.call("POST", "/v1/approvals", c.mgr, { scorecard_id: (await scorecard(c, "emp_dev_a")).scorecard_id })).json;
    const proof = world(a1);
    expect((await c.call("POST", `/v1/approvals/${a1.approval_id}/complete`, c.mgr, { decision: "approve", world_result: proof })).status).toBe(200);
    const a2 = (await c.call("POST", "/v1/approvals", c.mgr, { scorecard_id: (await scorecard(c, "emp_dev_b")).scorecard_id })).json;
    // A replayed proof carries the signal it was made for (a1); a fresh proof by the same human for a2 is legitimate.
    const replay = proof;
    expectError(await c.call("POST", `/v1/approvals/${a2.approval_id}/complete`, c.mgr, { decision: "approve", world_result: replay }), NEG.n04_world_proof_replayed);
  });

  it(nid("n05_cosign_token_reuse"), async () => {
    const c = await setup(false);
    const { pkg, tok } = await claim(c, "granted");
    expect((await c.call("POST", "/v1/cosign/sign", tok!, { signature: await sign(CFO, pkg!.typed_data) })).status).toBe(200);
    expectError(await c.call("GET", "/v1/cosign/view", tok!), NEG.n05_cosign_token_reuse);
  });

  it(nid("n06_wrong_signer"), async () => {
    const c = await setup(false);
    const { pkg, tok } = await claim(c, "granted");
    expectError(await c.call("POST", "/v1/cosign/sign", tok!, { signature: await sign(personaAccount("p_dev_b"), pkg!.typed_data) }), NEG.n06_wrong_signer);
  });

  it(nid("n07_wrong_chain_domain"), async () => {
    const c = await setup(false);
    const { cl, pkg } = await claim(c, "packaged");
    const sig = await sign(personaAccount("p_dev_a"), pkg!.typed_data, { chainId: 1 });
    expectError(await c.call("POST", `/v1/claims/${cl.claim_id}/submit`, c.asha, { employee_signature: sig }), NEG.n07_wrong_chain_domain);
  });

  it(nid("n08_tampered_claim"), async () => {
    const c = await setup(false);
    const { cl } = await claim(c, "packaged");
    expectError(await c.call("PATCH", `/v1/claims/${cl.claim_id}/draft`, c.asha, { body: { ...cl.body, duration_minutes: 600 } }), NEG.n08_tampered_claim);
  });

  it(nid("n09_unverified_not_counted"), async () => {
    const c = await setup();
    const compute = async () => (await c.call("POST", "/v1/scores/compute", c.hr, { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: C1 })).json;
    const before = await compute();
    await c.call("POST", "/v1/evidence/ingest", CONNECTOR, {
      employee_id: "emp_dev_a", cycle_id: C1, source: "worklog", kind: "daily_log", ref: "wl:n09", observed_at: "2026-12-10T00:00:00Z", observations: [{ metric_key: "deliverables", value: 5 }],
    });
    const after = await compute();
    const d = (r: any) => r.lines.find((l: any) => l.kra_id === "deliverables").actual;
    expect(d(after)).toBe(d(before));
    expect(after.verified_ratio_bps).toBeLessThan(before.verified_ratio_bps);
  });

  it(nid("n10_gate_fail_zero_payout"), async () => {
    const c = await setup();
    for (let i = 0; i < 6; i++) {
      await c.call("POST", "/v1/evidence/ingest", CONNECTOR, { employee_id: "emp_dev_a", cycle_id: C1, source: "manual", kind: "note", ref: `n10:${i}`, observed_at: "2026-12-10T00:00:00Z", observations: [] });
    }
    const r = (await c.call("POST", "/v1/scores/compute", c.hr, { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: C1 })).json;
    expect(r).toMatchObject(NEG.n10_gate_fail_zero_payout);
  });

  it(nid("n11_compute_deterministic"), async () => {
    const c = await setup();
    const body = { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: C1 };
    const a = await c.call("POST", "/v1/scores/compute", c.hr, body);
    const b = await c.call("POST", "/v1/scores/compute", c.hr, body);
    expect(a.body).toBe(b.body);
    expect(a.json.inputs_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it(nid("n12_duplicate_ingest_idempotent"), async () => {
    const c = await setup(false);
    const ev = { employee_id: "emp_dev_a", cycle_id: C1, source: "github", kind: "pr_merged", ref: "gh:n12", observed_at: "2026-12-01T00:00:00Z", observations: [{ metric_key: "deliverables", value: 1 }] };
    const a = await c.call("POST", "/v1/evidence/ingest", CONNECTOR, ev);
    const b = await c.call("POST", "/v1/evidence/ingest", CONNECTOR, ev);
    expect(b.status).toBe(201);
    expect(b.json.evidence_id).toBe(a.json.evidence_id);
    expect((await c.call("GET", "/v1/evidence?employee_id=emp_dev_a", c.hr)).json.items).toHaveLength(1);
  });

  it(nid("n13_float_rejected"), async () => {
    const c = await setup(false);
    expectError(
      await c.call("POST", "/v1/evidence/ingest", CONNECTOR, { employee_id: "emp_dev_a", cycle_id: C1, source: "github", kind: "pr_merged", ref: "f", observed_at: "2026-12-01T00:00:00Z", observations: [{ metric_key: "deliverables", value: 1.5 }] }),
      NEG.n13_float_rejected,
    );
    const { cl } = await claim(c, "drafted");
    expectError(await c.call("PATCH", `/v1/claims/${cl.claim_id}/draft`, c.asha, { body: { ...cl.body, duration_minutes: 45.5 } }), NEG.n13_float_rejected);
  });

  it(nid("n14_attest_after_revert_supersedes"), async () => {
    const c = await setup();
    await c.call("POST", "/v1/dev/inject", c.hr, { step_id: "s2_cosign_engagement" }); // v1 at full payout, as in the demo
    const v1 = await approved(c);
    const att1 = (await c.call("POST", "/v1/chain/attest", c.mgr, { scorecard_id: v1.scorecard_id })).json;
    await c.call("POST", `/v1/payouts/${v1.scorecard_id}/release`, c.mgr);
    await c.call("POST", "/v1/dev/inject", c.hr, { step_id: "s3_revert_pr" });
    const v2 = (await c.call("POST", `/v1/scorecards/${v1.scorecard_id}/revise`, c.mgr, { reason: "revert" })).json;
    const a = (await c.call("POST", "/v1/approvals", c.mgr, { scorecard_id: v2.scorecard_id })).json;
    await c.call("POST", `/v1/approvals/${a.approval_id}/complete`, c.mgr, { decision: "approve", world_result: world(a) });
    const att2 = (await c.call("POST", "/v1/chain/attest", c.mgr, { scorecard_id: v2.scorecard_id })).json;
    expect(att2.supersedes_attestation_id).toBe(att1.attestation_id);
    expect((await c.app.svc.chain.getAttestation(BigInt(att1.attestation_id))).revoked).toBe(true);
    expect((await c.call("GET", `/v1/scorecards/${v1.scorecard_id}`, c.mgr)).json.status).toBe("superseded");
    const audit = (await c.call("GET", "/v1/audit?limit=200", c.hr)).json.items.map((e: any) => e.action);
    expect(audit).toContain("payout.revision_applied");
    expect((await c.call("GET", `/v1/payouts/${v2.scorecard_id}`, c.mgr)).json.forfeited).toBe("474000000");
  });

  it(nid("n15_shred_keeps_verifiability"), async () => {
    const c = await setup();
    const id = (await c.call("GET", "/v1/evidence?employee_id=emp_dev_a", c.hr)).json.items[0].evidence_id;
    await c.call("POST", "/v1/chain/anchor", c.hr);
    await c.call("POST", `/v1/evidence/${id}/shred`, c.hr);
    const v = (await c.call("POST", "/v1/verify", {}, { kind: "evidence", id })).json;
    const chk = Object.fromEntries(v.checks.map((x: any) => [x.name, x]));
    expect(chk.evidence_not_shredded.ok).toBe(false);
    expect(chk.merkle_proof_valid.ok).toBe(true);
    expect(chk.commitment_matches.ok).toBe(false);
    expect(chk.commitment_matches.detail).toMatch(/cannot be recomputed/);
  });

  it(nid("n16_idor"), async () => {
    const c = await setup(false);
    const { cl } = await claim(c, "drafted");
    expectError(await c.call("GET", `/v1/claims/${cl.claim_id}`, await login(c.app, "p_dev_b")), NEG.n16_idor);
  });

  it(nid("n17_severity_set_by_fixer"), async () => {
    const c = await setup(false);
    const r = await c.call("POST", "/v1/evidence/ingest", CONNECTOR, {
      employee_id: "emp_dev_a", cycle_id: C1, source: "tickets", kind: "bug_fixed", ref: "jira:n17", observed_at: "2026-12-01T00:00:00Z", observations: [], severity: "P0", raw: { severity_set_by: "emp_dev_a" },
    });
    expect(r.json.status).toBe("unverified");
    expect(JSON.parse(c.app.svc.evidence.get(r.json.evidence_id)!.flags_json)).toContain("severity_set_by_fixer");
    const score = (await c.call("POST", "/v1/scores/compute", c.hr, { plan_id: "pln_eng_v1", employee_id: "emp_dev_a", cycle_id: C1 })).json;
    expect(score.bug_credit.total_milli).toBe(0);
  });

  it(nid("n18_dev_endpoints_off"), async () => {
    const app = await testApp({ AUTH_MODE: "sso" });
    const r = await app.inject({ method: "POST", url: "/v1/dev/login", payload: { persona_id: "p_dev_a" } });
    expect(r.statusCode).toBe(NEG.n18_dev_endpoints_off.http);
  });

  it("covers every negative test listed in the fixture", () => {
    expect([...covered].sort()).toEqual((S.negative_tests as any[]).map((n) => n.id).sort());
  });
});
