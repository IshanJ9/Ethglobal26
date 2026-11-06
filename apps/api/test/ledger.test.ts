import { describe, expect, it } from "vitest";
import { commit } from "@proofwork/crypto";
import { CONNECTOR, expectNoViolations, login, testApp } from "./helpers.ts";

const item = (over: Record<string, unknown> = {}) => ({
  employee_id: "emp_dev_a",
  cycle_id: "cyc_2026h2",
  source: "github",
  kind: "pr_merged",
  ref: "gh:acme/core#900",
  observed_at: "2026-12-05T10:00:00Z",
  observations: [{ metric_key: "deliverables", value: 2 }],
  ...over,
});

describe("evidence ledger", () => {
  it("rejects ingest without a valid connector key (401)", async () => {
    const app = await testApp();
    const r = await app.inject({ method: "POST", url: "/v1/evidence/ingest", payload: item(), headers: { "x-connector-key": "nope" } });
    expect(r.statusCode).toBe(401);
  });

  it("connector items are verified, worklog items unverified; commitment + chain link are correct", async () => {
    const app = await testApp();
    const a = await app.inject({ method: "POST", url: "/v1/evidence/ingest", payload: item(), headers: CONNECTOR });
    expect(a.statusCode).toBe(201);
    expect(a.json().status).toBe("verified");
    expect(a.json().seq).toBe(1);
    expect(a.json().prev_hash).toBe("0x" + "00".repeat(32));
    const b = await app.inject({
      method: "POST",
      url: "/v1/evidence/ingest",
      payload: item({ source: "worklog", kind: "daily_log", ref: "wl:1" }),
      headers: CONNECTOR,
    });
    expect(b.json().status).toBe("unverified");
    expect(b.json().prev_hash).toBe(a.json().event_hash);
    expect(app.svc.ledger.verifyChain()).toBeNull();

    // The stored salt reproduces the commitment over the canonical core (decrypted via the record DEK).
    const s = app.svc.evidence.secrets(a.json().evidence_id)!;
    const salt = app.svc.envelope.decrypt(app.svc.envelope.unwrap(s.dek_wrapped!), s.salt_enc!);
    const core = { source: "github", kind: "pr_merged", ref: "gh:acme/core#900", observed_at: "2026-12-05T10:00:00Z", observations: [{ metric_key: "deliverables", value: 2 }], severity: null, self_introduced: false, share_bps: 10000 };
    expect(commit(salt as `0x${string}`, core)).toBe(a.json().commitment);
    expectNoViolations(app);
  });

  it("n12: duplicate (source, kind, ref) returns the first item, count unchanged", async () => {
    const app = await testApp();
    const a = await app.inject({ method: "POST", url: "/v1/evidence/ingest", payload: item(), headers: CONNECTOR });
    const b = await app.inject({ method: "POST", url: "/v1/evidence/ingest", payload: item({ observations: [{ metric_key: "deliverables", value: 99 }] }), headers: CONNECTOR });
    expect(b.statusCode).toBe(201);
    // Same item; only the async replica status may have advanced (pending -> stored) in between.
    expect({ ...b.json(), replica: null }).toEqual({ ...a.json(), replica: null });
    const h = await login(app, "p_hr");
    const list = await app.inject({ method: "GET", url: "/v1/evidence?employee_id=emp_dev_a", headers: h });
    expect(list.json().items).toHaveLength(1);
  });

  it("n13: float observations are rejected with validation_failed", async () => {
    const app = await testApp();
    const r = await app.inject({ method: "POST", url: "/v1/evidence/ingest", payload: item({ observations: [{ metric_key: "deliverables", value: 2.5 }] }), headers: CONNECTOR });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("n17: severity set by the fixer keeps the item unverified", async () => {
    const app = await testApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/evidence/ingest",
      payload: item({ source: "tickets", kind: "bug_fixed", ref: "jira:BUG-77", severity: "P0", raw: { severity_set_by: "emp_dev_a" } }),
      headers: CONNECTOR,
    });
    expect(r.json().status).toBe("unverified");
    const row = app.svc.evidence.get(r.json().evidence_id)!;
    expect(JSON.parse(row.flags_json)).toContain("severity_set_by_fixer");
  });

  it("reverts_ref marks the target reverted and links both", async () => {
    const app = await testApp();
    const a = await app.inject({ method: "POST", url: "/v1/evidence/ingest", payload: item(), headers: CONNECTOR });
    const b = await app.inject({
      method: "POST",
      url: "/v1/evidence/ingest",
      payload: item({ kind: "pr_reverted", ref: "gh:acme/core#900-revert", observations: [], reverts_ref: "gh:acme/core#900" }),
      headers: CONNECTOR,
    });
    expect(b.json().links.reverts_evidence_id).toBe(a.json().evidence_id);
    expect(app.svc.ledger.get(a.json().evidence_id)!.status).toBe("reverted");
    expect(app.svc.audit.verifyChain()).toBeNull();
  });

  it("hash chain verification detects tampering", async () => {
    const app = await testApp();
    for (const n of [1, 2, 3]) await app.inject({ method: "POST", url: "/v1/evidence/ingest", payload: item({ ref: `gh:x#${n}` }), headers: CONNECTOR });
    expect(app.svc.ledger.verifyChain()).toBeNull();
    app.svc.db.prepare("UPDATE evidence SET commitment = ? WHERE seq = 2").run("0x" + "ab".repeat(32));
    expect(app.svc.ledger.verifyChain()).toBe(2);
  });

  it("audit log is hash-chained and tamper-evident", async () => {
    const app = await testApp();
    await login(app, "p_dev_a");
    await app.inject({ method: "POST", url: "/v1/evidence/ingest", payload: item(), headers: CONNECTOR });
    expect(app.svc.audit.verifyChain()).toBeNull();
    app.svc.db.prepare("UPDATE audit_log SET actor = 'evil' WHERE seq = 1").run();
    expect(app.svc.audit.verifyChain()).toBe(1);
  });
});
