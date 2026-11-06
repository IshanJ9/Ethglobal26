import { describe, expect, it } from "vitest";
import { ScaledChain } from "../src/chain/scaled.ts";
import type { ChainClient, PayoutState, RegisterArgs } from "../src/chain/types.ts";
import { runDemoStory, type Client } from "../src/dev/demo-story.ts";
import { expectNoViolations, testApp } from "./helpers.ts";

const SUBJECT = ("0x" + "11".repeat(32)) as `0x${string}`;

describe("ScaledChain (on-chain amounts at 1/N for testnet funding)", () => {
  it("divides the target going out and multiplies every payout amount coming back", async () => {
    const sent: RegisterArgs[] = [];
    const raw: PayoutState = {
      payee: "0x0000000000000000000000000000000000000001",
      targetBonus: 5_000_000n, holdbackBps: 2000, maturityAt: 9n, attestationId: 3n,
      entitlement: 4_463_500n, paid: 3_570_800n, held: 892_700n, forfeited: 1n, overpaid: 2n, status: 2,
    };
    const inner = {
      mode: "live",
      registerPlan: async (a: RegisterArgs) => (sent.push(a), { txHash: "0xab" }),
      getPayout: async () => raw,
    } as unknown as ChainClient;
    const c = new ScaledChain(inner, 1000);
    expect(c.mode).toBe("live");
    await c.registerPlan({ subjectId: SUBJECT, cycleId: 1n, payee: raw.payee, targetBonus: 5_000_000_000n, holdbackBps: 2000, maturitySeconds: 60n });
    expect(sent[0].targetBonus).toBe(5_000_000n);
    expect(await c.getPayout(SUBJECT, 1n)).toEqual({
      ...raw,
      targetBonus: 5_000_000_000n, entitlement: 4_463_500_000n, paid: 3_570_800_000n, held: 892_700_000n, forfeited: 1000n, overpaid: 2000n,
    });
  });

  it("refuses a target that does not divide exactly (never rounds money)", async () => {
    const c = new ScaledChain({ mode: "live", registerPlan: async () => ({ txHash: "0x" }) } as unknown as ChainClient, 1000);
    await expect(
      c.registerPlan({ subjectId: SUBJECT, cycleId: 1n, payee: "0x0000000000000000000000000000000000000001", targetBonus: 1_500n, holdbackBps: 0, maturitySeconds: 0n }),
    ).rejects.toThrow(/not divisible/);
    expect(() => new ScaledChain({} as ChainClient, 0)).toThrow();
  });

  for (const divisor of ["1000", "10000"]) {
    it(`full demo story at divisor ${divisor} reports exactly the unscaled amounts`, async () => {
      const app = await testApp({ CHAIN_AMOUNT_DIVISOR: divisor });
      const client: Client = {
        async call(method, url, body, headers = {}) {
          const r = await app.inject({ method: method as any, url, headers, ...(body !== undefined ? { payload: body as any } : {}) });
          return { status: r.statusCode, json: r.body ? r.json() : null };
        },
      };
      const out = await runDemoStory(client, { revealScorecard: (id) => app.svc.scorecardSvc.reveal(id) });
      expect(out.payout).toMatchObject({ target_bonus: "5000000000", entitlement: "4526000000", held: "526000000", forfeited: "474000000", overpaid: "0", status: "active" });
      expectNoViolations(app);
    });
  }
});
