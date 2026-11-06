import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { claimDigest, commit, makeDomain, recoverClaimSigner, toClaimMessage } from "@proofwork/crypto";
import { seedScenario } from "../src/fixtures.ts";
import { expectNoViolations, login, personaAccount, TestClock, testApp } from "./helpers.ts";

const S = seedScenario();
const C = Object.fromEntries((S.scripted_claims as any[]).map((c) => [c.id, c]));
const CFO = personaAccount("p_client_cfo");

async function setup(clock = new TestClock()) {
  const app = await testApp({}, { clock });
  return { app, clock };
}

async function createClaim(app: any, sc: any) {
  const h = await login(app, sc.employee);
  const r = await app.inject({
    method: "POST",
    url: "/v1/claims",
    headers: h,
    payload: { cycle_id: sc.cycle_id, kra_id: sc.kra_id, raw_text: sc.raw_text, cosigner_address: CFO.address, cosigner_label: "Acme Bank CFO" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return { h, claim: r.json() };
}

const signTyped = (acct: ReturnType<typeof personaAccount>, td: any) =>
  acct.signTypedData({ domain: td.domain, types: td.types, primaryType: "Claim", message: toClaimMessage(td.message) as any });

/** Drafted -> signing package -> employee signature -> pending_cosign -> grant. */
async function toGrant(app: any, sc: any, authMethod = sc.cosign_auth) {
  const { h, claim } = await createClaim(app, sc);
  const pkg = (await app.inject({ method: "GET", url: `/v1/claims/${claim.claim_id}/signing-package`, headers: h })).json();
  const sig = await signTyped(personaAccount(sc.employee), pkg.typed_data);
  const sub = await app.inject({ method: "POST", url: `/v1/claims/${claim.claim_id}/submit`, headers: h, payload: { employee_signature: sig } });
  expect(sub.statusCode, sub.body).toBe(200);
  const g = await app.inject({ method: "POST", url: `/v1/claims/${claim.claim_id}/cosign-grants`, headers: h, payload: { auth_method: authMethod } });
  expect(g.statusCode, g.body).toBe(201);
  return { h, claim: sub.json(), pkg, grant: g.json(), tok: { "x-cosign-token": g.json().token } };
}

describe("claims F1", () => {
  it("c1 happy path: draft -> verify-yourself -> sign -> co-sign -> verified; grant closes (n05)", async () => {
    const { app } = await setup();
    const { h, claim } = await createClaim(app, C.c1_happy_cosign);
    expect(claim.state).toBe("drafted");
    expect(claim.ai_flags).toEqual([]);
    expect(claim.body).toMatchObject({ schema: "pw.claim.v1", kind: "client_call", occurred_on: "2026-10-14", duration_minutes: 45, counterparty_label: "Acme Bank" });
    expect(claim.inference).toMatchObject({ provider: "mock", mode: "mock", tee_verified: null });

    const pkg = (await app.inject({ method: "GET", url: `/v1/claims/${claim.claim_id}/signing-package`, headers: h })).json();
    // What the web app does before signing: recompute commitments + digest with @proofwork/crypto.
    expect(commit(pkg.claim_salt, pkg.claim_value)).toBe(pkg.typed_data.message.claimCommitment);
    expect(commit(pkg.evidence_salt, pkg.evidence_value)).toBe(pkg.typed_data.message.evidenceCommitment);
    const domain = makeDomain(pkg.typed_data.domain.chainId, pkg.typed_data.domain.verifyingContract);
    expect(claimDigest(domain, toClaimMessage(pkg.typed_data.message))).toBe(pkg.digest);
    expect(pkg.typed_data.domain).toEqual({ name: "Proofwork", version: "1", chainId: 31337, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" });
    // Idempotent: same package again.
    const again = (await app.inject({ method: "GET", url: `/v1/claims/${claim.claim_id}/signing-package`, headers: h })).json();
    expect(again).toEqual(pkg);

    const sig = await signTyped(personaAccount("p_dev_a"), pkg.typed_data);
    const sub = (await app.inject({ method: "POST", url: `/v1/claims/${claim.claim_id}/submit`, headers: h, payload: { employee_signature: sig } })).json();
    expect(sub.state).toBe("pending_cosign");
    const ev = (await app.inject({ method: "GET", url: `/v1/evidence/${sub.evidence_id}`, headers: h })).json();
    expect(ev).toMatchObject({ source: "cosign", kind: "client_cosign", status: "unverified", commitment: pkg.typed_data.message.evidenceCommitment });

    const grant = (await app.inject({ method: "POST", url: `/v1/claims/${claim.claim_id}/cosign-grants`, headers: h, payload: { auth_method: "magic_link_wallet" } })).json();
    expect(grant.url).toBe(`/cosign#token=${grant.token}`);
    const tok = { "x-cosign-token": grant.token };
    const view = (await app.inject({ method: "GET", url: "/v1/cosign/view", headers: tok })).json();
    expect(view).toMatchObject({ claim_id: claim.claim_id, requester_display_name: "Asha Rao", employee_signature: sig });
    expect(view).not.toHaveProperty("employee_id");

    const cs = await signTyped(CFO, view.typed_data);
    expect(await recoverClaimSigner(domain, toClaimMessage(view.typed_data.message), cs)).toBe(CFO.address);
    const signed = await app.inject({ method: "POST", url: "/v1/cosign/sign", headers: tok, payload: { signature: cs } });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json().state).toBe("verified");
    expect(app.svc.ledger.get(sub.evidence_id)!.status).toBe("verified");

    // n05: the co-signer loses access.
    const closed = await app.inject({ method: "GET", url: "/v1/cosign/view", headers: tok });
    expect(closed.statusCode).toBe(410);
    expect(closed.json().error.code).toBe("grant_closed");
    expect((await app.inject({ method: "POST", url: "/v1/cosign/sign", headers: tok, payload: { signature: cs } })).statusCode).toBe(410);
    expect(app.svc.audit.verifyChain()).toBeNull();
    expectNoViolations(app);
  });

  it("n08: PATCH after the signing package is issued -> 409 invalid_state", async () => {
    const { app } = await setup();
    const { h, claim } = await createClaim(app, C.c1_happy_cosign);
    const body = { ...claim.body, duration_minutes: 60 };
    const ok = await app.inject({ method: "PATCH", url: `/v1/claims/${claim.claim_id}/draft`, headers: h, payload: { body } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().body.duration_minutes).toBe(60);
    const outside = await app.inject({ method: "PATCH", url: `/v1/claims/${claim.claim_id}/draft`, headers: h, payload: { body: { ...body, occurred_on: "2025-01-01" } } });
    expect(outside.json().error.code).toBe("validation_failed");
    await app.inject({ method: "GET", url: `/v1/claims/${claim.claim_id}/signing-package`, headers: h });
    const r = await app.inject({ method: "PATCH", url: `/v1/claims/${claim.claim_id}/draft`, headers: h, payload: { body: { ...body, duration_minutes: 600 } } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("invalid_state");
  });

  it("n07: employee signs with a different chainId -> 400 signature_mismatch", async () => {
    const { app } = await setup();
    const { h, claim } = await createClaim(app, C.c1_happy_cosign);
    const pkg = (await app.inject({ method: "GET", url: `/v1/claims/${claim.claim_id}/signing-package`, headers: h })).json();
    const sig = await signTyped(personaAccount("p_dev_a"), { ...pkg.typed_data, domain: { ...pkg.typed_data.domain, chainId: 1 } });
    const r = await app.inject({ method: "POST", url: `/v1/claims/${claim.claim_id}/submit`, headers: h, payload: { employee_signature: sig } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("signature_mismatch");
  });

  it("n06: co-signer signs with the wrong wallet -> 400 signature_mismatch (grant stays open)", async () => {
    const { app } = await setup();
    const { pkg, tok } = await toGrant(app, C.c1_happy_cosign);
    const wrong = await signTyped(personaAccount("p_hr"), pkg.typed_data);
    const r = await app.inject({ method: "POST", url: "/v1/cosign/sign", headers: tok, payload: { signature: wrong } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("signature_mismatch");
    expect((await app.inject({ method: "GET", url: "/v1/cosign/view", headers: tok })).statusCode).toBe(200);
  });

  it("c2 prompt injection: flagged, state untouched, World-ID co-sign with replay protection", async () => {
    const { app } = await setup();
    const { claim, pkg, grant, tok } = await toGrant(app, C.c2_prompt_injection, "world_id");
    expect(claim.ai_flags).toContain("prompt_injection_suspected");
    expect(claim.state).toBe("pending_cosign");
    expect(claim.kra_id).toBe("client_engagement");
    const view = (await app.inject({ method: "GET", url: "/v1/cosign/view", headers: tok })).json();
    expect(view.world_action).toBe(`pw-cosign-claim-${view.claim_id}`); // one World action per claim (CR-006)
    expect(view.ai_flags).toContain("prompt_injection_suspected"); // CR-001
    const cs = await signTyped(CFO, pkg.typed_data);

    const missing = await app.inject({ method: "POST", url: "/v1/cosign/sign", headers: tok, payload: { signature: cs } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("world_verification_failed");
    const wrongSignal = { adapter: "mock", payload: { action: "pw-cosign-claim", signal: "0x" + "00".repeat(32), nullifier: "0x" + randomBytes(32).toString("hex") } };
    expect((await app.inject({ method: "POST", url: "/v1/cosign/sign", headers: tok, payload: { signature: cs, world_result: wrongSignal } })).statusCode).toBe(401);

    const world = { adapter: "mock", payload: { action: view.world_action, signal: pkg.digest, nullifier: "0x" + randomBytes(32).toString("hex") } };
    const ok = await app.inject({ method: "POST", url: "/v1/cosign/sign", headers: tok, payload: { signature: cs, world_result: world } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().state).toBe("verified");
    expect(grant.auth_method).toBe("world_id");
    // Raw World proof is never stored.
    expect(JSON.stringify(app.svc.db.prepare("SELECT * FROM audit_log").all())).not.toContain(world.payload.nullifier.slice(2, 20));

    // Replay the same proof on another claim's grant.
    const second = await toGrant(app, { ...C.c2_prompt_injection, raw_text: "Second call with Acme Bank on 20 Oct." }, "world_id");
    const replay = world; // the captured proof is bound to the first claim's digest
    const cs2 = await signTyped(CFO, second.pkg.typed_data);
    const r = await app.inject({ method: "POST", url: "/v1/cosign/sign", headers: second.tok, payload: { signature: cs2, world_result: replay } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("world_verification_failed");
    expectNoViolations(app);
  });

  it("c3: co-signer declines -> declined, evidence rejected, grant closed", async () => {
    const { app } = await setup();
    const { claim, tok } = await toGrant(app, C.c3_cosigner_declines);
    const r = await app.inject({ method: "POST", url: "/v1/cosign/decline", headers: tok, payload: { reason: "I did not sign off on this." } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: "declined", decline_reason: "I did not sign off on this." });
    expect(app.svc.ledger.get(claim.evidence_id)!.status).toBe("rejected");
    expect((await app.inject({ method: "GET", url: "/v1/cosign/view", headers: tok })).statusCode).toBe(410);
    expectNoViolations(app);
  });

  it("grant expiry -> 410, claim expired, evidence rejected; a new grant revokes the old one", async () => {
    const clock = new TestClock();
    const { app } = await setup(clock);
    const { h, claim, tok } = await toGrant(app, C.c1_happy_cosign);
    const g2 = (await app.inject({ method: "POST", url: `/v1/claims/${claim.claim_id}/cosign-grants`, headers: h, payload: { auth_method: "magic_link_wallet", ttl_hours: 1 } })).json();
    expect((await app.inject({ method: "GET", url: "/v1/cosign/view", headers: tok })).statusCode).toBe(410);
    clock.advance(2 * 3600_000);
    const r = await app.inject({ method: "GET", url: "/v1/cosign/view", headers: { "x-cosign-token": g2.token } });
    expect(r.statusCode).toBe(410);
    expect(app.svc.claimsRepo.get(claim.claim_id)!.state).toBe("expired");
    expect(app.svc.ledger.get(claim.evidence_id)!.status).toBe("rejected");
  });

  it("unknown token -> 401; n16 IDOR on claims -> 404; input validation", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/v1/cosign/view", headers: { "x-cosign-token": "nope" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/cosign/view" })).statusCode).toBe(401);
    const { claim } = await createClaim(app, C.c1_happy_cosign);
    const b = await login(app, "p_dev_b");
    const r = await app.inject({ method: "GET", url: `/v1/claims/${claim.claim_id}`, headers: b });
    expect(r.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/claims", headers: b })).json().items).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/v1/claims/${claim.claim_id}`, headers: await login(app, "p_eng_mgr") })).statusCode).toBe(200);
    // Not claimable: a KRA fed by a system of record.
    const a = await login(app, "p_dev_a");
    const bad = await app.inject({ method: "POST", url: "/v1/claims", headers: a, payload: { cycle_id: "cyc_2026h2", kra_id: "deliverables", raw_text: "x", cosigner_address: CFO.address, cosigner_label: "x" } });
    expect(bad.json().error.code).toBe("validation_failed");
    // Self as co-signer.
    const self = await app.inject({ method: "POST", url: "/v1/claims", headers: a, payload: { cycle_id: "cyc_2026h2", kra_id: "client_engagement", raw_text: "x", cosigner_address: personaAccount("p_dev_a").address, cosigner_label: "me" } });
    expect(self.json().error.code).toBe("validation_failed");
    // n13 for claims: float in the draft body.
    const flt = await app.inject({ method: "PATCH", url: `/v1/claims/${claim.claim_id}/draft`, headers: a, payload: { body: { ...claim.body, duration_minutes: 4.5 } } });
    expect(flt.json().error.code).toBe("validation_failed");
    expectNoViolations(app);
  });
});
