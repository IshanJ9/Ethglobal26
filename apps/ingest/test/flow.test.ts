// End to end against the real Proofwork API, in-process (apps/api's own test app: mock chain/World/0G).
// Bot input -> redaction -> claim (AI draft) -> employee signature -> co-sign link -> client co-signs -> verified.
// GitHub webhook -> HMAC -> /v1/evidence/ingest -> verified system-of-record evidence, idempotent on redelivery.
import { createHmac } from "node:crypto";
import { strToU8 } from "fflate";
import { toClaimMessage } from "@proofwork/crypto";
import { describe, expect, it } from "vitest";
import { CONNECTOR, login, personaAccount, testApp } from "../../api/test/helpers.ts";
import { ProofworkApi, type Fetch } from "../src/api.ts";
import { IngestCore } from "../src/core.ts";
import { Bindings, makeLinkCode } from "../src/links.ts";

const SECRET = "test-link-secret-123";
const GH_SECRET = "gh-webhook-secret";
const TG_USER = 4242;

async function setup() {
  const app = await testApp();
  const fetchImpl: Fetch = async (url, init) => {
    const r = await app.inject({ method: init.method as any, url: url.replace("http://api.test", ""), headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
    return { status: r.statusCode, text: async () => r.body };
  };
  const core = new IngestCore({
    api: new ProofworkApi("http://api.test", fetchImpl),
    linkSecret: SECRET,
    connectorKey: CONNECTOR["x-connector-key"],
    cosigner: { address: personaAccount("p_client_cfo").address, label: "Client CFO, Acme Bank" },
    webBase: "http://web.test",
    bindings: new Bindings(null),
    cycleId: "cyc_2026h2",
    github: { secret: GH_SECRET, ctx: { cycleId: "cyc_2026h2", logins: { "asha-dev": "emp_dev_a", ben: "emp_dev_b" } } },
  });
  return { app, core };
}

describe("ingest flow against the real API", () => {
  it("rejects unlinked users and bad link codes", async () => {
    const { core } = await setup();
    await expect(core.prepare(TG_USER, "telegram_text", "did stuff")).rejects.toThrow(/not linked/);
    await expect(core.link(TG_USER, "deadbeef_zz_0000000000")).rejects.toThrow(/invalid or expired/);
  });

  it("Telegram text -> redacted claim -> signed -> co-sign link -> client signs -> verified", async () => {
    const { app, core } = await setup();
    const linked = await core.link(TG_USER, makeLinkCode(SECRET, "p_dev_a", Math.floor(Date.now() / 1000) + 3600));
    expect(linked.displayName).toBe("Asha Rao");

    const { pending, kras } = await core.prepare(TG_USER, "telegram_text", "Ran a 90 minute architecture review with Acme Bank's CFO today. Reach me on +91 98200 12345.");
    expect(pending.text).toContain("[PHONE]");
    expect(pending.text).not.toContain("98200");
    expect(kras.map((k) => k.kra_id)).toEqual(["client_engagement"]);

    const claim = await core.file(TG_USER, pending.id, "client_engagement");
    expect(claim).toMatchObject({ state: "drafted", employee_id: "emp_dev_a", kra_id: "client_engagement" });
    expect(claim.evidence_excerpt).not.toContain("98200");

    const r = await core.requestCosign(TG_USER, claim.claim_id);
    expect(r.cosignUrl).toMatch(/^http:\/\/web\.test\/cosign#token=/);
    const token = new URL(r.cosignUrl!).hash.split("token=")[1];

    // The client opens the link and signs with their wallet.
    const tok = { "x-cosign-token": token };
    const view = (await app.inject({ method: "GET", url: "/v1/cosign/view", headers: tok })).json();
    const signature = await personaAccount("p_client_cfo").signTypedData({ domain: view.typed_data.domain, types: view.typed_data.types, primaryType: "Claim", message: toClaimMessage(view.typed_data.message) as any });
    const signed = await app.inject({ method: "POST", url: "/v1/cosign/sign", headers: tok, payload: { signature } });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().state).toBe("verified");
    expect(app.contractGuard.violations).toEqual([]);
  });

  it("plans with no co-signable KRA (sales commission, marketing) get a clear refusal", async () => {
    const { core } = await setup();
    await core.link(TG_USER, makeLinkCode(SECRET, "p_ae", Math.floor(Date.now() / 1000) + 3600));
    await expect(core.prepare(TG_USER, "telegram_forward", "Client said: deal signed")).rejects.toThrow(/no KRA that accepts co-signed claims/);
  });

  it("forward and WhatsApp export become pending items with names pseudonymised", async () => {
    const { core } = await setup();
    await core.link(TG_USER, makeLinkCode(SECRET, "p_dev_a", Math.floor(Date.now() / 1000) + 3600));
    const wa = `[05/11/26, 10:00:00] Asha Rao: Sent pricing to asha@okaxis
[05/11/26, 10:05:00] Rohan Mehta: Approved, sign tomorrow
[06/11/26, 11:00:00] Rohan Mehta: Contract signed, PO 4471 raised`;
    const r = await core.prepareWhatsApp(TG_USER, "WhatsApp Chat.txt", strToU8(wa));
    expect(r.totalMessages).toBe(3);
    expect(r.items.map((i) => i.day)).toEqual(["2026-11-06", "2026-11-05"]);
    const text = r.items.map((i) => i.pending.text).join("\n");
    expect(text).not.toMatch(/Asha|Rohan|okaxis/);
    expect(text).toContain("Person 2: Contract signed");
    expect(r.items[0].kras.length).toBeGreaterThan(0);
  });

  it("GitHub webhook: HMAC enforced, merged PR ingested as verified, redelivery is idempotent", async () => {
    const { app, core } = await setup();
    const body = JSON.stringify({
      action: "closed",
      repository: { full_name: "acme/core" },
      pull_request: { number: 777, merged: true, merged_at: "2026-11-06T10:00:00Z", title: "Add retries", user: { login: "asha-dev" }, html_url: "https://github.com/acme/core/pull/777" },
    });
    const sig = "sha256=" + createHmac("sha256", GH_SECRET).update(body).digest("hex");
    expect((await core.github("pull_request", body, "sha256=00")).status).toBe(401);

    const first = await core.github("pull_request", body, sig);
    expect(first.status).toBe(200);
    expect((first.body as any).ingested).toEqual([expect.objectContaining({ kind: "pr_merged", ref: "gh:acme/core#777", status: "verified" })]);
    const again = await core.github("pull_request", body, sig);
    expect((again.body as any).ingested[0].evidence_id).toBe((first.body as any).ingested[0].evidence_id);

    const h = await login(app, "p_dev_a");
    const list = (await app.inject({ method: "GET", url: "/v1/evidence?cycle_id=cyc_2026h2", headers: h })).json();
    expect(list.items.filter((e: any) => e.ref === "gh:acme/core#777")).toHaveLength(1);
    expect((await core.github("ping", "{}", "sha256=" + createHmac("sha256", GH_SECRET).update("{}").digest("hex"))).body).toMatchObject({ pong: true });
  });
});
