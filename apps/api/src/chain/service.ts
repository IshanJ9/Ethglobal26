// Anchor (AGENT_A 3.5), attest (3.6), payout read-model + vault operations (3.7).
// Rule: nothing is attested without an approved approval; nothing is paid without an attestation.
import { buildMerkle, keccakUtf8, merkleLeaf, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { getAddress } from "viem";
import type { Config } from "../config.ts";
import { ApiError, errors } from "../errors.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { EvidenceRepo } from "../db/evidence.ts";
import type { DB } from "../db/index.ts";
import type { OrgRepo, Persona } from "../db/org.ts";
import type { ChainRepo, ScorecardRepo, ScorecardRow } from "../db/scorecards.ts";
import { canApprove, canView, isHr, isInternal } from "../auth/auth.ts";
import type { ComputeResult } from "../scoring/compute.ts";
import type { ScorecardService } from "../scoring/scorecards.ts";
import { iso, newId, type Clock } from "../util.ts";
import { PAYOUT_STATUS, type ChainClient, type PayoutState } from "./types.ts";

export type AnchorBatch = components["schemas"]["AnchorBatch"];
export type AttestationRef = components["schemas"]["AttestationRef"];
export type Payout = components["schemas"]["Payout"];

export class ChainService {
  constructor(
    private readonly db: DB,
    private readonly chain: ChainClient,
    private readonly repo: ChainRepo,
    private readonly scorecardsRepo: ScorecardRepo,
    private readonly scorecards: ScorecardService,
    private readonly evidence: EvidenceRepo,
    private readonly org: OrgRepo,
    private readonly audit: AuditRepo,
    private readonly config: Config,
    private readonly clock: Clock,
  ) {}

  private now() {
    return iso(this.clock.now());
  }
  explorer(tx: string | null): string | null {
    return tx && this.config.EXPLORER_BASE_URL ? `${this.config.EXPLORER_BASE_URL.replace(/\/$/, "")}/tx/${tx}` : null;
  }

  // ---------------- anchor ----------------

  private batchApi(b: { batch_id: string; numeric_id: number; root: string; count: number; tx_hash: string; chain_mode: string; anchored_at: string }): AnchorBatch {
    return {
      batch_id: b.batch_id,
      numeric_id: b.numeric_id,
      root: b.root,
      count: b.count,
      evidence_ids: this.repo.batchEvidenceIds(b.batch_id),
      tx_hash: b.tx_hash,
      chain_mode: b.chain_mode as "mock" | "live",
      explorer_url: this.explorer(b.tx_hash),
      anchored_at: b.anchored_at,
    };
  }

  checkOperator(p: Persona) {
    if (!isInternal(p) || !(p.role === "manager" || isHr(p))) throw errors.forbidden("Only managers or HR can trigger chain operations");
  }

  async anchor(actor: string): Promise<AnchorBatch> {
    const items = this.repo.unanchoredEvidence();
    if (!items.length) throw errors.conflict("Nothing to anchor: all evidence is already in a batch");
    const tree = buildMerkle(items.map((i) => i.commitment as Hex));
    // Batch ids must be unused on chain (a fresh DB against a live chain must not collide).
    let numeric = this.repo.maxBatchNumeric() + 1;
    while ((await this.chain.batchRoot(BigInt(numeric))) !== ("0x" + "00".repeat(32))) numeric++;
    const { txHash } = await this.chain.anchorBatch(tree.root, BigInt(numeric), items.length);
    const b = { batch_id: newId("bat"), numeric_id: numeric, root: tree.root, count: items.length, tx_hash: txHash, chain_mode: this.chain.mode, anchored_at: this.now() };
    this.db.transaction(() => {
      this.repo.insertBatch(
        b,
        items.map((i) => {
          const c = i.commitment as Hex;
          return { evidence_id: i.evidence_id, leaf_index: tree.leaves.indexOf(merkleLeaf(c)), proof: tree.proofFor(c) };
        }),
      );
      this.audit.append(b.anchored_at, actor, "chain.anchored", b.batch_id, { numeric_id: numeric, root: tree.root, count: items.length, tx_hash: txHash });
    })();
    return this.batchApi(b);
  }

  getBatch(id: string): AnchorBatch {
    const b = this.repo.batch(id);
    if (!b) throw errors.notFound("Batch not found");
    return this.batchApi(b);
  }

  // ---------------- attest ----------------

  async attest(p: Persona, scorecardId: string): Promise<AttestationRef> {
    const sc = this.scorecards.visible(p, scorecardId);
    const employee = this.org.employee(sc.employee_id)!;
    if (!canApprove(p, employee)) throw errors.forbidden("Only the employee's manager or HR can attest");
    const approval = sc.approval_id ? this.scorecardsRepo.approval(sc.approval_id) : undefined;
    if (sc.status === "attested" || sc.status === "superseded") throw errors.conflict("Scorecard is already attested", { status: sc.status });
    if (sc.status !== "approved" || approval?.status !== "approved" || !approval.proof_hash) {
      throw new ApiError(409, "approval_required", "An approved human approval is required before attestation", {
        scorecard_status: sc.status,
        approval_status: approval?.status ?? null,
      });
    }

    // Evidence used by this scorecard must be anchored first.
    const ids = JSON.parse(sc.evidence_ids_json) as string[];
    if (ids.some((id) => !this.evidence.get(id)?.batch_id)) await this.anchor(p.persona_id);

    const { subject, cycleNumeric } = this.scorecards.subjectOf(sc.employee_id, sc.cycle_id);
    const cyc = BigInt(cycleNumeric);
    const result = JSON.parse(sc.result_json) as ComputeResult;
    const plan = this.org.plan(employee.plan_id)!;
    const supersedes = await this.chain.latestAttestation(subject, cyc);
    const att = await this.chain.attestScore({
      subjectId: subject,
      cycleId: cyc,
      version: sc.version,
      scoreCommitment: sc.score_commitment as Hex,
      evidenceRoot: sc.evidence_root as Hex,
      formulaHash: plan.formula_hash as Hex,
      approvalProofHash: approval.proof_hash as Hex,
      multiplierBps: result.multiplier_bps,
      supersedes,
    });
    const key = `${subject}:${cycleNumeric}`;

    // First attestation for (subject, cycle): register the plan in the vault.
    let payout = await this.chain.getPayout(subject, cyc);
    if (payout.status === 0) {
      const target = plan.kind === "tiered_commission" ? BigInt(result.bonus_amount) : BigInt(plan.target_bonus);
      const reg = await this.chain.registerPlan({
        subjectId: subject,
        cycleId: cyc,
        payee: getAddress(employee.wallet_address),
        targetBonus: target,
        holdbackBps: plan.holdback_bps,
        maturitySeconds: BigInt(plan.maturity_days) * 86400n,
      });
      this.repo.setLastPayoutTx(key, reg.txHash);
      payout = await this.chain.getPayout(subject, cyc);
    }

    const at = this.now();
    const ref: AttestationRef = {
      attestation_id: Number(att.attestationId),
      scorecard_id: sc.scorecard_id,
      version: sc.version,
      supersedes_attestation_id: supersedes === 0n ? null : Number(supersedes),
      tx_hash: att.txHash,
      chain_mode: this.chain.mode,
      explorer_url: this.explorer(att.txHash),
      attested_at: at,
    };
    this.db.transaction(() => {
      this.repo.insertAttestation({
        attestation_id: ref.attestation_id,
        scorecard_id: sc.scorecard_id,
        version: sc.version,
        supersedes_id: ref.supersedes_attestation_id ?? null,
        tx_hash: att.txHash,
        chain_mode: this.chain.mode,
        attested_at: at,
      });
      this.scorecardsRepo.update(sc.scorecard_id, { status: "attested", attestation_json: JSON.stringify(ref) });
      if (supersedes !== 0n) {
        const old = this.scorecardsRepo.byAttestationId(Number(supersedes));
        if (old) this.scorecardsRepo.update(old.scorecard_id, { status: "superseded" });
      }
      for (const id of ids) {
        const e = this.evidence.get(id);
        if (e?.status === "verified") this.evidence.setStatus(id, "provisional");
      }
      this.audit.append(at, p.persona_id, "chain.attested", sc.scorecard_id, {
        attestation_id: ref.attestation_id,
        supersedes: ref.supersedes_attestation_id,
        tx_hash: att.txHash,
        multiplier_bps: result.multiplier_bps,
      });
    })();

    // Re-base an already-released payout on the new attestation (ENGINE.md revision).
    if (supersedes !== 0n && payout.attestationId === supersedes) {
      const before = payout;
      const rev = await this.chain.applyRevision(supersedes, att.attestationId);
      this.repo.setLastPayoutTx(key, rev.txHash);
      const after = await this.chain.getPayout(subject, cyc);
      this.audit.append(this.now(), p.persona_id, "payout.revision_applied", sc.scorecard_id, {
        old_attestation_id: Number(supersedes),
        new_attestation_id: ref.attestation_id,
        new_entitlement: after.entitlement.toString(),
        held_remaining: after.held.toString(),
        forfeited: (after.forfeited - before.forfeited).toString(),
        overpaid: after.overpaid.toString(),
        tx_hash: rev.txHash,
      });
    }
    return ref;
  }

  // ---------------- payouts ----------------

  private ctx(sc: ScorecardRow) {
    const { subject, cycleNumeric } = this.scorecards.subjectOf(sc.employee_id, sc.cycle_id);
    return { subject, cyc: BigInt(cycleNumeric), key: `${subject}:${cycleNumeric}` };
  }

  private toPayout(sc: ScorecardRow, s: PayoutState, key: string): Payout {
    const employee = this.org.employee(sc.employee_id)!;
    const plan = this.org.plan(employee.plan_id)!;
    const registered = s.status !== 0;
    const last = this.repo.lastPayoutTx(key);
    return {
      scorecard_id: sc.scorecard_id,
      status: PAYOUT_STATUS[s.status] ?? "none",
      payee: getAddress(registered ? s.payee : employee.wallet_address),
      target_bonus: (registered ? s.targetBonus : BigInt(plan.target_bonus)).toString(),
      entitlement: s.entitlement.toString(),
      paid: s.paid.toString(),
      held: s.held.toString(),
      forfeited: s.forfeited.toString(),
      overpaid: s.overpaid.toString(),
      maturity_at: s.maturityAt > 0n ? new Date(Number(s.maturityAt) * 1000).toISOString() : null,
      last_tx_hash: last,
      explorer_url: this.explorer(last),
    };
  }

  /** Chain truth for the (subject, cycle) of this scorecard. */
  async getPayout(p: Persona, scorecardId: string): Promise<Payout> {
    const sc = this.scorecards.visible(p, scorecardId);
    const { subject, cyc, key } = this.ctx(sc);
    return this.toPayout(sc, await this.chain.getPayout(subject, cyc), key);
  }

  private async vaultOp(
    p: Persona,
    scorecardId: string,
    who: "approver" | "viewer" | "hr",
    op: string,
    run: (s: PayoutState, sc: ScorecardRow) => Promise<{ txHash: Hex }>,
    precheck: (s: PayoutState, sc: ScorecardRow, now: bigint) => void,
  ): Promise<Payout> {
    const sc = this.scorecards.visible(p, scorecardId);
    const employee = this.org.employee(sc.employee_id)!;
    if (who === "approver" && !canApprove(p, employee)) throw errors.forbidden("Only the employee's manager or HR can do this");
    if (who === "hr" && !isHr(p)) throw errors.forbidden("Only HR can resolve disputes");
    if (who === "viewer" && !canView(p, employee)) throw errors.notFound("Scorecard not found");
    const { subject, cyc, key } = this.ctx(sc);
    const before = await this.chain.getPayout(subject, cyc);
    precheck(before, sc, await this.chain.now());
    const { txHash } = await run(before, sc);
    this.repo.setLastPayoutTx(key, txHash);
    const after = await this.chain.getPayout(subject, cyc);
    this.audit.append(this.now(), p.persona_id, `payout.${op}`, sc.scorecard_id, {
      tx_hash: txHash,
      paid: after.paid.toString(),
      held: after.held.toString(),
      forfeited: after.forfeited.toString(),
      status: PAYOUT_STATUS[after.status],
    });
    return this.toPayout(sc, after, key);
  }

  release(p: Persona, scorecardId: string) {
    return this.vaultOp(
      p,
      scorecardId,
      "approver",
      "released",
      (_s, sc) => this.chain.release(BigInt(JSON.parse(sc.attestation_json!).attestation_id)),
      (s, sc) => {
        if (sc.status !== "attested" || !sc.attestation_json) throw new ApiError(409, "approval_required", "Scorecard must be approved and attested before payout", { status: sc.status });
        if (s.status !== 1) throw errors.invalidState(`Payout is ${PAYOUT_STATUS[s.status]}, not registered`, { payout_status: PAYOUT_STATUS[s.status] });
      },
    );
  }

  async releaseHoldback(p: Persona, scorecardId: string) {
    const res = await this.vaultOp(
      p,
      scorecardId,
      "approver",
      "holdback_released",
      (s) => this.chain.releaseHoldback(s.attestationId),
      (s, _sc, now) => {
        if (s.status !== 2) throw errors.invalidState(`Payout is ${PAYOUT_STATUS[s.status]}, not active`, { payout_status: PAYOUT_STATUS[s.status] });
        if (now < s.maturityAt) throw errors.invalidState("Holdback has not matured yet", { maturity_at: new Date(Number(s.maturityAt) * 1000).toISOString() });
      },
    );
    // Provisional credit becomes vested once the holdback is released after maturity.
    const sc = this.scorecardsRepo.get(scorecardId)!;
    const gov = this.scorecardsRepo.attested(sc.employee_id, sc.cycle_id);
    for (const id of JSON.parse((gov ?? sc).evidence_ids_json) as string[]) if (this.evidence.get(id)?.status === "provisional") this.evidence.setStatus(id, "vested");
    return res;
  }

  dispute(p: Persona, scorecardId: string, reason: string) {
    return this.vaultOp(
      p,
      scorecardId,
      "viewer",
      "disputed",
      (s) => this.chain.dispute(s.attestationId, keccakUtf8(reason)),
      (s) => {
        if (s.status !== 2) throw errors.invalidState("Only an active payout can be disputed", { payout_status: PAYOUT_STATUS[s.status] });
      },
    );
  }

  resolve(p: Persona, scorecardId: string, releaseFunds: boolean) {
    return this.vaultOp(
      p,
      scorecardId,
      "hr",
      releaseFunds ? "dispute_resolved_released" : "dispute_resolved_forfeited",
      (s) => this.chain.resolveDispute(s.attestationId, releaseFunds),
      (s) => {
        if (s.status !== 3) throw errors.invalidState("Payout is not disputed", { payout_status: PAYOUT_STATUS[s.status] });
      },
    );
  }
}
