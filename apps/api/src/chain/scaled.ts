// ScaledChain: runs the vault at 1/divisor of the real amounts, for a testnet that cannot fund the
// fixture targets (5,000 USDC). Only two places carry money across the boundary:
//   out: registerPlan.targetBonus is divided by the divisor (it must divide exactly, never rounds);
//   in:  getPayout amounts are multiplied back, so scorecards, payouts and verify stay at full scale.
// The contracts compute entitlement / holdback / forfeit on the scaled target, so a value scaled back can
// differ from the full-scale figure by less than `divisor` base units only when the scaled product does
// not divide evenly; for the seed fixtures every amount is exact. The divisor is surfaced to the UI so the
// demo says "on-chain amounts scaled 1:N" instead of implying real 5,000 USDC moved.
import type { Hex } from "@proofwork/crypto";
import type { AttestArgs, ChainClient, PayoutState, RegisterArgs } from "./types.ts";
import { ChainRevert } from "./types.ts";

export class ScaledChain implements ChainClient {
  readonly mode: "mock" | "live";
  private readonly d: bigint;

  constructor(private readonly inner: ChainClient, public readonly divisor: number) {
    if (!Number.isSafeInteger(divisor) || divisor < 1) throw new Error(`bad chain amount divisor ${divisor}`);
    this.mode = inner.mode;
    this.d = BigInt(divisor);
  }

  async registerPlan(a: RegisterArgs) {
    if (a.targetBonus % this.d !== 0n) {
      throw new ChainRevert(`target ${a.targetBonus} is not divisible by CHAIN_AMOUNT_DIVISOR=${this.divisor}`, "registerPlan");
    }
    return this.inner.registerPlan({ ...a, targetBonus: a.targetBonus / this.d });
  }

  async getPayout(subjectId: Hex, cycleId: bigint): Promise<PayoutState> {
    const p = await this.inner.getPayout(subjectId, cycleId);
    const up = (x: bigint) => x * this.d;
    return {
      ...p,
      targetBonus: up(p.targetBonus),
      entitlement: up(p.entitlement),
      paid: up(p.paid),
      held: up(p.held),
      forfeited: up(p.forfeited),
      overpaid: up(p.overpaid),
    };
  }

  anchorBatch(root: Hex, batchId: bigint, count: number) { return this.inner.anchorBatch(root, batchId, count); }
  attestScore(a: AttestArgs) { return this.inner.attestScore(a); }
  revoke(id: bigint, reasonHash: Hex) { return this.inner.revoke(id, reasonHash); }
  release(attId: bigint) { return this.inner.release(attId); }
  releaseHoldback(attId: bigint) { return this.inner.releaseHoldback(attId); }
  dispute(attId: bigint, reasonHash: Hex) { return this.inner.dispute(attId, reasonHash); }
  resolveDispute(attId: bigint, release: boolean) { return this.inner.resolveDispute(attId, release); }
  applyRevision(oldId: bigint, newId: bigint) { return this.inner.applyRevision(oldId, newId); }
  getAttestation(id: bigint) { return this.inner.getAttestation(id); }
  batchRoot(batchId: bigint) { return this.inner.batchRoot(batchId); }
  latestAttestation(subjectId: Hex, cycleId: bigint) { return this.inner.latestAttestation(subjectId, cycleId); }
  now() { return this.inner.now(); }
}
