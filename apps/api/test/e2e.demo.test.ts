import { describe, expect, it } from "vitest";
import { runDemoStory, type Client } from "../src/dev/demo-story.ts";
import { expectNoViolations, testApp } from "./helpers.ts";

describe("e2e demo story (mock chain/World/0G)", () => {
  it("s1 -> c1 -> v1 approve/attest/release -> n02 -> s3 revert -> v2 -> applyRevision -> s4 -> shred", async () => {
    const app = await testApp();
    const client: Client = {
      async call(method, url, body, headers = {}) {
        const r = await app.inject({ method: method as any, url, headers, ...(body !== undefined ? { payload: body as any } : {}) });
        return { status: r.statusCode, json: r.body ? r.json() : null };
      },
    };
    const out = await runDemoStory(client, { revealScorecard: (id) => app.svc.scorecardSvc.reveal(id) });
    expect(out.payout).toMatchObject({ entitlement: "4526000000", held: "526000000", forfeited: "474000000", overpaid: "0", status: "active" });
    expect(app.svc.audit.verifyChain()).toBeNull();
    expect(app.svc.ledger.verifyChain()).toBeNull();
    expectNoViolations(app);
  });
});
