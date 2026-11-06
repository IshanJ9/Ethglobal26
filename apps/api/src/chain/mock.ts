// In-process simulation of AttestationRegistry + BonusVault with the SAME revert rules (AGENT_B 2.1/2.2)
// and the exact payout_split / revision math of spec/ENGINE.md. State persists in mockchain_state.
// Tx hashes = keccak(canonicalJson({op, args, n})).
import { canonicalJson, keccakUtf8, type Hex } from "@proofwork/crypto";
import type { Address } from "viem";
import type { DB } from "../db/index.ts";
import type { Clock } from "../util.ts";
import { ChainRevert, ZERO32, type AttestArgs, type Attestation, type ChainClient, type PayoutState, type RegisterArgs } from "./types.ts";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
/** Simulated fundCycle: every cycle starts with 1,000,000 USDC so demo flows never starve. */
export const MOCK_CYCLE_FUNDING = 1_000_000_000_000n;

interface PlanState extends PayoutState {
  maturitySeconds: bigint;
}
interface State {
  n: number;
  batches: Record<string, Hex>;
  attestations: Attestation[]; // index = id - 1
  latest: Record<string, string>; // `${subject}:${cycle}` -> id
  payouts: Record<string, PlanState>;
  cycleBalance: Record<string, string>;
}

const max0 = (x: bigint) => (x > 0n ? x : 0n);
const k = (s: Hex, c: bigint) => `${s}:${c}`;

// JSON with bigint support for persistence.
const enc = (s: State) => JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? { $b: v.toString() } : v));
const dec = (t: string): State => JSON.parse(t, (_k, v) => (v && typeof v === "object" && "$b" in v ? BigInt(v.$b) : v));

export class MockChain implements ChainClient {
  readonly mode = "mock" as const;
  private s: State;

  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {
    const row = db.prepare("SELECT v FROM mockchain_state WHERE k = 'state'").pluck().get() as string | undefined;
    this.s = row ? dec(row) : { n: 0, batches: {}, attestations: [], latest: {}, payouts: {}, cycleBalance: {} };
  }

  private save() {
    this.db.prepare("INSERT INTO mockchain_state (k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(enc(this.s));
  }

  /** Run `fn` on a copy; commit only if it does not revert (atomic like a tx). */
  private tx(op: string, args: Record<string, unknown>, fn: (s: State) => void): { txHash: Hex } {
    const draft = dec(enc(this.s));
    try {
      fn(draft);
    } catch (e) {
      if (e instanceof ChainRevert) throw e;
      throw new ChainRevert((e as Error).message, op);
    }
    draft.n += 1;
    this.s = draft;
    this.save();
    const safeArgs = JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    return { txHash: keccakUtf8(canonicalJson({ op, args: safeArgs, n: draft.n })) };
  }

  private nowS() {
    return BigInt(Math.floor(this.clock.now().getTime() / 1000));
  }

  private balance(s: State, cycle: bigint) {
    return BigInt(s.cycleBalance[String(cycle)] ?? MOCK_CYCLE_FUNDING.toString());
  }
  private setBalance(s: State, cycle: bigint, v: bigint) {
    s.cycleBalance[String(cycle)] = v.toString();
  }

  private att(s: State, id: bigint): Attestation {
    const a = s.attestations[Number(id) - 1];
    if (id < 1n || !a) throw new ChainRevert("unknown attestation", "getAttestation");
    return a;
  }

  async now() {
    return this.nowS();
  }

  async anchorBatch(root: Hex, batchId: bigint, count: number) {
    return this.tx("anchorBatch", { root, batchId, count }, (s) => {
      if (root === ZERO32) throw new ChainRevert("zero root", "anchorBatch");
      if (count <= 0) throw new ChainRevert("zero count", "anchorBatch");
      if (s.batches[String(batchId)]) throw new ChainRevert("batch exists", "anchorBatch");
      s.batches[String(batchId)] = root;
    });
  }

  async attestScore(a: AttestArgs) {
    let id = 0n;
    const t = this.tx("attestScore", { ...a }, (s) => {
      if (a.subjectId === ZERO32) throw new ChainRevert("zero subject", "attestScore");
      if (a.version < 1) throw new ChainRevert("bad version", "attestScore");
      if (a.multiplierBps > 30000) throw new ChainRevert("multiplier too high", "attestScore");
      const key = k(a.subjectId, a.cycleId);
      if (a.supersedes !== 0n) {
        const old = this.att(s, a.supersedes);
        if (old.revoked) throw new ChainRevert("superseded is revoked", "attestScore");
        if (old.subjectId !== a.subjectId || old.cycleId !== a.cycleId) throw new ChainRevert("supersede subject/cycle mismatch", "attestScore");
        if (a.version <= old.version) throw new ChainRevert("version must increase", "attestScore");
        old.revoked = true;
      } else if (s.latest[key] && s.latest[key] !== "0") {
        throw new ChainRevert("must supersede", "attestScore");
      }
      s.attestations.push({ ...a, attestedAt: this.nowS(), revoked: false });
      id = BigInt(s.attestations.length);
      s.latest[key] = id.toString();
    });
    return { ...t, attestationId: id };
  }

  async revoke(id: bigint, reasonHash: Hex) {
    return this.tx("revoke", { id, reasonHash }, (s) => {
      const a = this.att(s, id);
      a.revoked = true;
      const key = k(a.subjectId, a.cycleId);
      if (s.latest[key] === id.toString()) s.latest[key] = "0";
    });
  }

  async registerPlan(r: RegisterArgs) {
    return this.tx("registerPlan", { ...r }, (s) => {
      const key = k(r.subjectId, r.cycleId);
      if (s.payouts[key] && s.payouts[key].status !== 0) throw new ChainRevert("already registered", "registerPlan");
      if (r.payee === ZERO_ADDR) throw new ChainRevert("zero payee", "registerPlan");
      if (r.holdbackBps > 10000) throw new ChainRevert("bad holdback", "registerPlan");
      s.payouts[key] = {
        payee: r.payee,
        targetBonus: r.targetBonus,
        holdbackBps: r.holdbackBps,
        maturityAt: 0n,
        attestationId: 0n,
        entitlement: 0n,
        paid: 0n,
        held: 0n,
        forfeited: 0n,
        overpaid: 0n,
        status: 1,
        maturitySeconds: r.maturitySeconds,
      };
    });
  }

  private planFor(s: State, a: Attestation, op: string): PlanState {
    const p = s.payouts[k(a.subjectId, a.cycleId)];
    if (!p || p.status === 0) throw new ChainRevert("plan not registered", op);
    return p;
  }

  async release(attId: bigint) {
    return this.tx("release", { attId }, (s) => {
      const a = this.att(s, attId);
      if (a.revoked) throw new ChainRevert("attestation revoked", "release");
      const p = this.planFor(s, a, "release");
      if (p.status !== 1) throw new ChainRevert("not in Registered state", "release");
      const ent = (p.targetBonus * BigInt(a.multiplierBps)) / 10000n;
      const imm = (ent * (10000n - BigInt(p.holdbackBps))) / 10000n;
      const bal = this.balance(s, a.cycleId);
      if (bal < ent) throw new ChainRevert("insufficient cycle balance", "release");
      this.setBalance(s, a.cycleId, bal - ent);
      Object.assign(p, {
        attestationId: attId,
        entitlement: ent,
        paid: imm,
        held: ent - imm,
        maturityAt: this.nowS() + p.maturitySeconds,
        status: ent === 0n ? 4 : 2,
      });
    });
  }

  async releaseHoldback(attId: bigint) {
    return this.tx("releaseHoldback", { attId }, (s) => {
      const a = this.att(s, attId);
      const p = this.planFor(s, a, "releaseHoldback");
      if (p.attestationId !== attId) throw new ChainRevert("not the governing attestation", "releaseHoldback");
      if (a.revoked) throw new ChainRevert("attestation revoked", "releaseHoldback");
      if (p.status !== 2) throw new ChainRevert("not Active", "releaseHoldback");
      if (this.nowS() < p.maturityAt) throw new ChainRevert("not matured", "releaseHoldback");
      p.paid += p.held;
      p.held = 0n;
      p.status = 4;
    });
  }

  async dispute(attId: bigint, reasonHash: Hex) {
    return this.tx("dispute", { attId, reasonHash }, (s) => {
      const p = this.planFor(s, this.att(s, attId), "dispute");
      if (p.attestationId !== attId) throw new ChainRevert("not the governing attestation", "dispute");
      if (p.status !== 2) throw new ChainRevert("not Active", "dispute");
      p.status = 3;
    });
  }

  async resolveDispute(attId: bigint, release: boolean) {
    return this.tx("resolveDispute", { attId, release }, (s) => {
      const a = this.att(s, attId);
      const p = this.planFor(s, a, "resolveDispute");
      if (p.attestationId !== attId) throw new ChainRevert("not the governing attestation", "resolveDispute");
      if (p.status !== 3) throw new ChainRevert("not Disputed", "resolveDispute");
      if (release) p.paid += p.held;
      else {
        p.forfeited += p.held;
        this.setBalance(s, a.cycleId, this.balance(s, a.cycleId) + p.held);
      }
      p.held = 0n;
      p.status = 4;
    });
  }

  async applyRevision(oldId: bigint, newId: bigint) {
    return this.tx("applyRevision", { oldId, newId }, (s) => {
      const nw = this.att(s, newId);
      const p = this.planFor(s, nw, "applyRevision");
      if (p.attestationId !== oldId) throw new ChainRevert("old is not the governing attestation", "applyRevision");
      const old = this.att(s, oldId);
      if (old.subjectId !== nw.subjectId || old.cycleId !== nw.cycleId) throw new ChainRevert("subject/cycle mismatch", "applyRevision");
      if (nw.revoked) throw new ChainRevert("new attestation revoked", "applyRevision");
      if (nw.supersedes !== oldId) throw new ChainRevert("new does not supersede old", "applyRevision");
      const newEnt = (p.targetBonus * BigInt(nw.multiplierBps)) / 10000n;
      const heldRemaining = max0(newEnt - p.paid);
      const overpaid = max0(p.paid - newEnt);
      const forfeited = max0(p.held - heldRemaining);
      const extraOwed = max0(heldRemaining - p.held);
      const bal = this.balance(s, nw.cycleId);
      if (extraOwed > bal) throw new ChainRevert("insufficient cycle balance for extraOwed", "applyRevision");
      this.setBalance(s, nw.cycleId, bal + forfeited - extraOwed);
      const wasClosed = p.status === 4;
      Object.assign(p, {
        held: heldRemaining,
        entitlement: newEnt,
        attestationId: newId,
        forfeited: p.forfeited + forfeited,
        overpaid,
      });
      if (wasClosed && heldRemaining > 0n) p.status = 2;
    });
  }

  async getAttestation(id: bigint): Promise<Attestation> {
    return { ...this.att(this.s, id) };
  }

  async getPayout(subjectId: Hex, cycleId: bigint): Promise<PayoutState> {
    const p = this.s.payouts[k(subjectId, cycleId)];
    if (!p) {
      return { payee: ZERO_ADDR, targetBonus: 0n, holdbackBps: 0, maturityAt: 0n, attestationId: 0n, entitlement: 0n, paid: 0n, held: 0n, forfeited: 0n, overpaid: 0n, status: 0 };
    }
    const { maturitySeconds: _m, ...rest } = p;
    return { ...rest };
  }

  async batchRoot(batchId: bigint): Promise<Hex> {
    return this.s.batches[String(batchId)] ?? ZERO32;
  }

  async latestAttestation(subjectId: Hex, cycleId: bigint): Promise<bigint> {
    return BigInt(this.s.latest[k(subjectId, cycleId)] ?? "0");
  }
}
