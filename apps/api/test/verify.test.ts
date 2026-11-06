import { describe, expect, it } from "vitest";
import { expectNoViolations, login, testApp } from "./helpers.ts";

async function anchored() {
  const app = await testApp();
  const hr = await login(app, "p_hr");
  const ids = (await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } })).json().evidence_ids;
  const b = await app.inject({ method: "POST", url: "/v1/chain/anchor", headers: hr });
  expect(b.statusCode).toBe(201);
  return { app, hr, ids, batch: b.json() };
}

const checks = (r: any) => Object.fromEntries(r.checks.map((c: any) => [c.name, c.ok]));

describe("verify + anchor + shred", () => {
  it("anchor: batch over all unanchored evidence; empty set -> 409; batch readable", async () => {
    const { app, hr, ids, batch } = await anchored();
    expect(batch).toMatchObject({ numeric_id: 1, count: ids.length, chain_mode: "mock" });
    expect(batch.evidence_ids.sort()).toEqual([...ids].sort());
    expect((await app.inject({ method: "POST", url: "/v1/chain/anchor", headers: hr })).json().error.code).toBe("conflict");
    expect((await app.inject({ method: "GET", url: `/v1/chain/batches/${batch.batch_id}`, headers: hr })).json().root).toBe(batch.root);
    expect((await app.inject({ method: "POST", url: "/v1/chain/anchor", headers: await login(app, "p_dev_a") })).statusCode).toBe(403);
    expectNoViolations(app);
  });

  it("evidence: correct reveal passes, tampered reveal fails", async () => {
    const { app, ids } = await anchored();
    const id = ids[0];
    const s = app.svc.evidence.secrets(id)!;
    const dek = app.svc.envelope.unwrap(s.dek_wrapped!);
    const salt = app.svc.envelope.decrypt(dek, s.salt_enc!);
    const core = JSON.parse(app.svc.envelope.decrypt(dek, s.payload_enc!)).core;
    const ok = (await app.inject({ method: "POST", url: "/v1/verify", payload: { kind: "evidence", id, reveal: { value: core, salt } } })).json();
    expect(ok.ok).toBe(true);
    expect(checks(ok)).toMatchObject({ commitment_matches: true, merkle_proof_valid: true, root_anchored_on_chain: true, hash_chain_intact: true, evidence_not_shredded: true });
    const tampered = { ...core, observations: core.observations.map((o: any) => ({ ...o, value: o.value + 1 })) };
    const bad = (await app.inject({ method: "POST", url: "/v1/verify", payload: { kind: "evidence", id, reveal: { value: tampered, salt } } })).json();
    expect(bad.ok).toBe(false);
    expect(checks(bad).commitment_matches).toBe(false);
    expectNoViolations(app);
  });

  it("n15: shred destroys the data key; Merkle proof stays valid; only HR may shred", async () => {
    const { app, hr, ids } = await anchored();
    const id = ids[1];
    expect((await app.inject({ method: "POST", url: `/v1/evidence/${id}/shred`, headers: await login(app, "p_eng_mgr") })).statusCode).toBe(403);
    const s = await app.inject({ method: "POST", url: `/v1/evidence/${id}/shred`, headers: hr });
    expect(s.json()).toMatchObject({ status: "shredded", replica: { status: "shredded", zg_root: null } });
    expect(app.svc.evidence.secrets(id)).toMatchObject({ dek_wrapped: null, salt_enc: null, payload_enc: null });
    const v = (await app.inject({ method: "POST", url: "/v1/verify", payload: { kind: "evidence", id } })).json();
    expect(checks(v)).toMatchObject({ evidence_not_shredded: false, commitment_matches: false, merkle_proof_valid: true, root_anchored_on_chain: true });
    expectNoViolations(app);
  });

  it("unknown id -> 404; unanchored evidence reports not anchored", async () => {
    const app = await testApp();
    expect((await app.inject({ method: "POST", url: "/v1/verify", payload: { kind: "evidence", id: "evd_nope" } })).statusCode).toBe(404);
    const hr = await login(app, "p_hr");
    const ids = (await app.inject({ method: "POST", url: "/v1/dev/inject", headers: hr, payload: { step_id: "s1_collect_baseline" } })).json().evidence_ids;
    const v = (await app.inject({ method: "POST", url: "/v1/verify", payload: { kind: "evidence", id: ids[0] } })).json();
    expect(checks(v).merkle_proof_valid).toBe(false);
  });
});
