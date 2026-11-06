// ChainClient: the backend is the ONLY transaction sender (INTEGRATION section 7).
// MockChain and ViemChain implement the same interface and the same revert rules (AGENT_B 2.1/2.2).
import type { Hex } from "@proofwork/crypto";
import type { Address } from "viem";

export interface Attestation {
  subjectId: Hex;
  cycleId: bigint;
  version: number;
  scoreCommitment: Hex;
  evidenceRoot: Hex;
  formulaHash: Hex;
  approvalProofHash: Hex;
  multiplierBps: number;
  supersedes: bigint;
  attestedAt: bigint;
  revoked: boolean;
}

export const PAYOUT_STATUS = ["none", "registered", "active", "disputed", "closed"] as const;
export type PayoutStatusName = (typeof PAYOUT_STATUS)[number];

export interface PayoutState {
  payee: Address;
  targetBonus: bigint;
  holdbackBps: number;
  maturityAt: bigint;
  attestationId: bigint;
  entitlement: bigint;
  paid: bigint;
  held: bigint;
  forfeited: bigint;
  overpaid: bigint;
  status: number; // index into PAYOUT_STATUS
}

export interface AttestArgs {
  subjectId: Hex;
  cycleId: bigint;
  version: number;
  scoreCommitment: Hex;
  evidenceRoot: Hex;
  formulaHash: Hex;
  approvalProofHash: Hex;
  multiplierBps: number;
  supersedes: bigint;
}

export interface RegisterArgs {
  subjectId: Hex;
  cycleId: bigint;
  payee: Address;
  targetBonus: bigint;
  holdbackBps: number;
  maturitySeconds: bigint;
}

export interface Tx {
  txHash: Hex;
}

export interface ChainClient {
  readonly mode: "mock" | "live";
  anchorBatch(root: Hex, batchId: bigint, count: number): Promise<Tx>;
  attestScore(a: AttestArgs): Promise<Tx & { attestationId: bigint }>;
  revoke(id: bigint, reasonHash: Hex): Promise<Tx>;
  registerPlan(a: RegisterArgs): Promise<Tx>;
  release(attId: bigint): Promise<Tx>;
  releaseHoldback(attId: bigint): Promise<Tx>;
  dispute(attId: bigint, reasonHash: Hex): Promise<Tx>;
  resolveDispute(attId: bigint, release: boolean): Promise<Tx>;
  applyRevision(oldId: bigint, newId: bigint): Promise<Tx>;
  getAttestation(id: bigint): Promise<Attestation>;
  getPayout(subjectId: Hex, cycleId: bigint): Promise<PayoutState>;
  batchRoot(batchId: bigint): Promise<Hex>;
  latestAttestation(subjectId: Hex, cycleId: bigint): Promise<bigint>;
  /** Chain time in unix seconds (block timestamp for live, clock for mock). */
  now(): Promise<bigint>;
}

/** A contract revert (or RPC failure) surfaced as 502 chain_error with details.revert. */
export class ChainRevert extends Error {
  constructor(public readonly revert: string, public readonly op: string) {
    super(`${op} reverted: ${revert}`);
    this.name = "ChainRevert";
  }
}

export const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
