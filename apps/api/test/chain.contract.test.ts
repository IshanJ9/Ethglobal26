// One behavioural suite for ChainClient. Runs against MockChain always; against ViemChain only when
// CHAIN_TEST_LIVE=1 (uses apps/api/.env; sends real testnet transactions).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Hex } from "@proofwork/crypto";
import { openDb } from "../src/db/index.ts";
import { MockChain } from "../src/chain/mock.ts";
import { ViemChain } from "../src/chain/viem.ts";
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { specJson } from "../src/fixtures.ts";
import type { ChainClient } from "../src/chain/types.ts";
import { TestClock } from "./helpers.ts";

const V = specJson("vectors/vectors.json");
const rnd = () => ("0x" + randomBytes(32).toString("hex")) as Hex;
const PAYEE = "0xe0A6B36D1381B1844A569acecde5501cA3Aca9c1";

function suite(name: string, make: () => { chain: ChainClient; clock?: TestClock }) {
  describe(name, () => {
    const attest = (c: ChainClient, subject: Hex, cycle: bigint, version: number, mult: number, supersedes = 0n) =>
      c.attestScore({ subjectId: subject, cycleId: cycle, version, scoreCommitment: rnd(), evidenceRoot: rnd(), formulaHash: rnd(), approvalProofHash: rnd(), multiplierBps: mult, supersedes });

    it("c01: anchor; duplicate batch id and zero root revert", async () => {
      const { chain } = make();
      const id = BigInt(1 + Math.floor(Math.random() * 1e9));
      const root = rnd();
      await chain.anchorBatch(root, id, 3);
      expect(await chain.batchRoot(id)).toBe(root);
      await expect(chain.anchorBatch(rnd(), id, 1)).rejects.toThrow();
      await expect(chain.anchorBatch(("0x" + "00".repeat(32)) as Hex, id + 1n, 1)).rejects.toThrow();
    });

    it("c02-c04: supersede rules", async () => {
      const { chain } = make();
      const s = rnd();
      const a1 = await attest(chain, s, 1n, 1, 10000);
      expect(await chain.latestAttestation(s, 1n)).toBe(a1.attestationId);
      await expect(attest(chain, s, 1n, 2, 9000)).rejects.toThrow(); // must supersede
      await expect(attest(chain, s, 1n, 1, 9000, a1.attestationId)).rejects.toThrow(); // version must increase
      await expect(attest(chain, rnd(), 1n, 2, 9000, a1.attestationId)).rejects.toThrow(); // wrong subject
      const a2 = await attest(chain, s, 1n, 2, 9000, a1.attestationId);
      expect((await chain.getAttestation(a1.attestationId)).revoked).toBe(true);
      expect(await chain.latestAttestation(s, 1n)).toBe(a2.attestationId);
    });

    it("c05-c08: payout_split, revision_cases, revoked release reverts", async () => {
      const { chain } = make();
      for (const rc of V.revision_cases) {
        const s = rnd();
        const split = V.payout_split_cases[0];
        await chain.registerPlan({ subjectId: s, cycleId: 1n, payee: PAYEE, targetBonus: BigInt(rc.target_bonus), holdbackBps: split.holdback_bps, maturitySeconds: 0n });
        const a1 = await attest(chain, s, 1n, 1, split.multiplier_bps);
        await chain.release(a1.attestationId);
        const p1 = await chain.getPayout(s, 1n);
        expect(p1.paid.toString()).toBe(rc.paid);
        expect(p1.held.toString()).toBe(rc.held);
        const a2 = await attest(chain, s, 1n, 2, rc.new_multiplier_bps, a1.attestationId);
        await expect(chain.release(a1.attestationId)).rejects.toThrow(); // c08 revoked
        await chain.applyRevision(a1.attestationId, a2.attestationId);
        const p2 = await chain.getPayout(s, 1n);
        expect([p2.entitlement, p2.held, p2.forfeited, p2.overpaid].map(String), rc.name).toEqual([
          rc.expected.new_entitlement,
          rc.expected.held_remaining,
          rc.expected.forfeited,
          rc.expected.overpaid,
        ]);
      }
    });

    it("c09-c10: holdback maturity, double release, dispute + resolve", async () => {
      const { chain, clock } = make();
      const s = rnd();
      await chain.registerPlan({ subjectId: s, cycleId: 1n, payee: PAYEE, targetBonus: 5_000_000_000n, holdbackBps: 2000, maturitySeconds: 3600n });
      const a = await attest(chain, s, 1n, 1, 10000);
      await chain.release(a.attestationId);
      await expect(chain.release(a.attestationId)).rejects.toThrow();
      await expect(chain.releaseHoldback(a.attestationId)).rejects.toThrow();
      if (clock) {
        clock.advance(3601_000);
        await chain.releaseHoldback(a.attestationId);
        expect((await chain.getPayout(s, 1n)).paid).toBe(5_000_000_000n);
      }
      const s2 = rnd();
      await chain.registerPlan({ subjectId: s2, cycleId: 1n, payee: PAYEE, targetBonus: 1_000_000n, holdbackBps: 5000, maturitySeconds: 0n });
      const b = await attest(chain, s2, 1n, 1, 10000);
      await chain.release(b.attestationId);
      await expect(chain.resolveDispute(b.attestationId, true)).rejects.toThrow();
      await chain.dispute(b.attestationId, rnd());
      await expect(chain.releaseHoldback(b.attestationId)).rejects.toThrow();
      await chain.resolveDispute(b.attestationId, true);
      expect((await chain.getPayout(s2, 1n)).paid).toBe(1_000_000n);
    });
  });
}

suite("MockChain", () => {
  const clock = new TestClock();
  return { chain: new MockChain(openDb(":memory:"), clock), clock };
});

if (process.env.CHAIN_TEST_LIVE === "1") {
  loadEnvFile();
  suite("ViemChain (live)", () => ({ chain: new ViemChain(parseConfig()) }));
}
