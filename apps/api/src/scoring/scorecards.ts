// Scorecards (AGENT_A 3.3) and approvals (3.4). Versioned, never overwritten; a revision is a new version
// that supersedes the old one. Approvals bind a World step-up to a server challenge.
import { buildMerkle, canonicalJson, keccakUtf8, randomSalt, scoreCommitment, subjectId, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { randomBytes } from "node:crypto";
import type { Config } from "../config.ts";
import { ApiError, errors } from "../errors.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { DB } from "../db/index.ts";
import type { OrgRepo, Persona } from "../db/org.ts";
import type { ApprovalRow, ScorecardRepo, ScorecardRow } from "../db/scorecards.ts";
import { canApprove, canView, viewableEmployee, visibleEmployeeIds } from "../auth/auth.ts";
import { COUNTED } from "../engine/engine.ts";
import type { Envelope } from "../ledger/envelope.ts";
import { consumeNullifier, worldResultHash, type WorldResult, type WorldVerifier } from "../world/verifier.ts";
import type { ComputeResult, ComputeService } from "./compute.ts";
import { iso, newId, type Clock } from "../util.ts";

export type Scorecard = components["schemas"]["Scorecard"];
export type ScorecardDiff = components["schemas"]["ScorecardDiff"];
export type Approval = components["schemas"]["Approval"];
export const APPROVAL_WORLD_ACTION = "pw-approve-scorecard";

export function toScorecard(r: ScorecardRow): Scorecard {
  const s: Scorecard = {
    scorecard_id: r.scorecard_id,
    employee_id: r.employee_id,
    cycle_id: r.cycle_id,
    version: r.version,
    supersedes_scorecard_id: r.supersedes_id,
    revision_reason: r.reason,
    status: r.status as Scorecard["status"],
    result: JSON.parse(r.result_json),
    evidence_ids: JSON.parse(r.evidence_ids_json),
    approval_id: r.approval_id,
    needs_revision: !!r.needs_revision,
    attestation: r.attestation_json ? JSON.parse(r.attestation_json) : null,
    created_at: r.created_at,
  };
  if (r.evidence_root) s.evidence_root = r.evidence_root;
  if (r.score_commitment) s.score_commitment = r.score_commitment;
  if (r.subject_id) s.subject_id = r.subject_id;
  return s;
}

export function toApproval(r: ApprovalRow): Approval {
  return {
    approval_id: r.approval_id,
    scorecard_id: r.scorecard_id,
    status: r.status as Approval["status"],
    challenge: r.challenge,
    world_action: r.world_action,
    approver_employee_id: r.approver_employee_id,
    comment: r.comment,
    approval_proof_hash: r.proof_hash,
    created_at: r.created_at,
    decided_at: r.decided_at,
  };
}

/** HASHING.md section 4 score object: pseudonymous subject, never a name. */
export function scoreObject(a: {
  planId: string;
  formulaHash: string;
  subject: string;
  cycleNumeric: number;
  version: number;
  result: ComputeResult;
  evidenceRoot: string;
}) {
  return {
    schema: "pw.score.v1",
    plan_id: a.planId,
    formula_hash: a.formulaHash,
    employee_ref: a.subject,
    cycle_id: a.cycleNumeric,
    version: a.version,
    score_bps: a.result.score_bps,
    multiplier_bps: a.result.multiplier_bps,
    bonus_amount: a.result.bonus_amount,
    lines: a.result.lines.map((l) => ({ kra_id: l.kra_id, actual: l.actual, target: l.target, contribution_ppm: l.contribution_ppm })),
    evidence_root: a.evidenceRoot,
  };
}

export class ScorecardService {
  constructor(
    private readonly db: DB,
    private readonly repo: ScorecardRepo,
    private readonly org: OrgRepo,
    private readonly compute: ComputeService,
    private readonly audit: AuditRepo,
    private readonly envelope: Envelope,
    private readonly world: WorldVerifier,
    private readonly config: Config,
    private readonly clock: Clock,
  ) {}

  private now() {
    return iso(this.clock.now());
  }

  visible(p: Persona, id: string): ScorecardRow {
    const r = this.repo.get(id);
    if (!r || !canView(p, this.org.employee(r.employee_id))) throw errors.notFound("Scorecard not found");
    return r;
  }

  subjectOf(employeeId: string, cycleId: string): { subject: Hex; cycleNumeric: number } {
    const c = this.org.cycle(cycleId)!;
    return { subject: subjectId(this.config.ORG_SECRET as Hex, employeeId, c.numeric_id), cycleNumeric: c.numeric_id };
  }

  create(p: Persona, employeeId: string, cycleId: string, opts: { reason?: string; supersedes?: string } = {}): Scorecard {
    const employee = viewableEmployee(p, this.org, employeeId);
    if (!this.org.cycle(cycleId)) throw errors.notFound("Cycle not found");
    const inputs = this.compute.loadInputs(employee.plan_id, employeeId, cycleId);
    const result = this.compute.evaluate(inputs, { employeeId });
    const counted = inputs.evidence.filter((e) => COUNTED.has(e.status));
    if (!counted.length) throw new ApiError(422, "validation_failed", "no verified evidence: a scorecard needs at least one counted evidence item");
    const evidenceIds = counted.map((e) => e.evidence_id).sort();
    const evidenceRoot = buildMerkle(counted.map((e) => e.commitment as Hex)).root;
    const { subject, cycleNumeric } = this.subjectOf(employeeId, cycleId);
    const now = this.now();

    return this.db.transaction(() => {
      const version = this.repo.maxVersion(employeeId, cycleId) + 1;
      const supersedes = opts.supersedes ?? this.repo.attested(employeeId, cycleId)?.scorecard_id ?? null;
      const obj = scoreObject({ planId: inputs.plan.plan_id, formulaHash: inputs.plan.formula_hash, subject, cycleNumeric, version, result, evidenceRoot });
      const salt = randomSalt();
      const { dek, wrapped } = this.envelope.newDek();
      const row: ScorecardRow = {
        scorecard_id: newId("scd"),
        employee_id: employeeId,
        cycle_id: cycleId,
        version,
        supersedes_id: supersedes,
        reason: opts.reason ?? null,
        status: "draft",
        result_json: JSON.stringify(result),
        evidence_ids_json: JSON.stringify(evidenceIds),
        evidence_root: evidenceRoot,
        score_commitment: scoreCommitment(salt, obj),
        score_salt_enc: JSON.stringify({ dek_wrapped: wrapped, salt_enc: this.envelope.encrypt(dek, salt) }),
        score_object_json: JSON.stringify(obj),
        subject_id: subject,
        approval_id: null,
        needs_revision: 0,
        attestation_json: null,
        created_at: now,
      };
      this.repo.insert(row);
      this.audit.append(now, p.persona_id, opts.reason ? "scorecard.revised" : "scorecard.created", row.scorecard_id, {
        version,
        supersedes,
        score_commitment: row.score_commitment,
        evidence_root: evidenceRoot,
        inputs_hash: result.inputs_hash,
      });
      return toScorecard(row);
    })();
  }

  revise(p: Persona, id: string, reason: string): Scorecard {
    const old = this.visible(p, id);
    return this.create(p, old.employee_id, old.cycle_id, { reason, supersedes: old.scorecard_id });
  }

  get(p: Persona, id: string) {
    return toScorecard(this.visible(p, id));
  }

  list(p: Persona, f: { employee_id?: string; cycle_id?: string }) {
    const ids = f.employee_id ? [viewableEmployee(p, this.org, f.employee_id).employee_id] : visibleEmployeeIds(p, this.org);
    return this.repo.list({ employeeIds: ids, cycleId: f.cycle_id }).map(toScorecard);
  }

  /** GET /scorecards/{to}/diff/{from}: deltas are to - from. */
  diff(p: Persona, toId: string, fromId: string): ScorecardDiff {
    const to = this.visible(p, toId);
    const from = this.visible(p, fromId);
    if (to.employee_id !== from.employee_id) throw errors.validation("Scorecards belong to different employees");
    const a = JSON.parse(from.result_json) as ComputeResult;
    const b = JSON.parse(to.result_json) as ComputeResult;
    const fromLines = new Map(a.lines.map((l) => [l.kra_id, l]));
    const line_changes = b.lines
      .map((l) => {
        const o = fromLines.get(l.kra_id);
        return { kra_id: l.kra_id, actual_from: o?.actual ?? 0, actual_to: l.actual, contribution_ppm_delta: l.contribution_ppm - (o?.contribution_ppm ?? 0) };
      })
      .filter((c) => c.actual_from !== c.actual_to || c.contribution_ppm_delta !== 0);
    const ea = new Set<string>(JSON.parse(from.evidence_ids_json));
    const eb = new Set<string>(JSON.parse(to.evidence_ids_json));
    return {
      from_id: from.scorecard_id,
      to_id: to.scorecard_id,
      score_bps_delta: b.score_bps - a.score_bps,
      multiplier_bps_delta: b.multiplier_bps - a.multiplier_bps,
      bonus_amount_delta: (BigInt(b.bonus_amount) - BigInt(a.bonus_amount)).toString(),
      line_changes,
      evidence_added: [...eb].filter((x) => !ea.has(x)).sort(),
      evidence_removed: [...ea].filter((x) => !eb.has(x)).sort(),
    };
  }

  /** Reveal for the owner of a scorecard (used by /v1/verify tests and the e2e script). */
  reveal(id: string): { value: unknown; salt: Hex } | null {
    const r = this.repo.get(id);
    if (!r?.score_salt_enc || !r.score_object_json) return null;
    const s = JSON.parse(r.score_salt_enc) as { dek_wrapped: string; salt_enc: string };
    const salt = this.envelope.decrypt(this.envelope.unwrap(s.dek_wrapped), s.salt_enc) as Hex;
    return { value: JSON.parse(r.score_object_json), salt };
  }

  // ---------------- approvals ----------------

  private approvable(p: Persona, sc: ScorecardRow) {
    const employee = this.org.employee(sc.employee_id)!;
    if (!canApprove(p, employee)) throw errors.forbidden(p.employee_id === employee.employee_id ? "You cannot approve your own scorecard" : "Only the employee's manager or HR can approve");
  }

  createApproval(p: Persona, scorecardId: string): Approval {
    const sc = this.visible(p, scorecardId);
    this.approvable(p, sc);
    const pending = this.repo.pendingApproval(sc.scorecard_id);
    if (pending) return toApproval(pending);
    if (sc.status !== "draft") throw errors.invalidState("Only draft scorecards can be sent for approval", { status: sc.status });
    const nonce = "0x" + randomBytes(32).toString("hex");
    const now = this.now();
    const row: ApprovalRow = {
      approval_id: newId("apr"),
      scorecard_id: sc.scorecard_id,
      status: "pending",
      challenge: keccakUtf8(canonicalJson({ scorecard_id: sc.scorecard_id, score_commitment: sc.score_commitment, nonce })),
      nonce,
      world_action: APPROVAL_WORLD_ACTION,
      approver_employee_id: null,
      comment: null,
      proof_hash: null,
      world_result_hash: null,
      created_at: now,
      decided_at: null,
    };
    this.db.transaction(() => {
      this.repo.insertApproval(row);
      this.repo.update(sc.scorecard_id, { status: "pending_approval", approval_id: row.approval_id });
      this.audit.append(now, p.persona_id, "approval.requested", row.approval_id, { scorecard_id: sc.scorecard_id, challenge: row.challenge });
    })();
    return toApproval(row);
  }

  private approvalVisible(p: Persona, id: string): { a: ApprovalRow; sc: ScorecardRow } {
    const a = this.repo.approval(id);
    if (!a) throw errors.notFound("Approval not found");
    return { a, sc: this.visible(p, a.scorecard_id) };
  }

  getApproval(p: Persona, id: string) {
    return toApproval(this.approvalVisible(p, id).a);
  }

  async completeApproval(p: Persona, id: string, body: { decision: "approve" | "deny"; comment?: string; world_result?: WorldResult }): Promise<Approval> {
    const { a, sc } = this.approvalVisible(p, id);
    this.approvable(p, sc); // n01: never the employee
    if (a.status !== "pending") throw errors.invalidState("Approval is not pending", { status: a.status });

    let nullifier: string | null = null;
    if (body.decision === "approve") {
      const chk = await this.world.verify({ action: a.world_action, signal: a.challenge, result: body.world_result });
      if (!chk.ok) {
        this.audit.append(this.now(), p.persona_id, "approval.world_failed", a.approval_id, { reason: chk.reason });
        throw new ApiError(401, "world_verification_failed", `World verification failed: ${chk.reason}`);
      }
      nullifier = chk.nullifier;
    }
    const decidedAt = this.now();
    const wrh = body.world_result ? worldResultHash(body.world_result) : null;
    const cycle = this.org.cycle(sc.cycle_id)!;
    const approverRef = subjectId(this.config.ORG_SECRET as Hex, p.employee_id, cycle.numeric_id);
    const decision = body.decision;
    const proofHash = keccakUtf8(
      canonicalJson({ approval_id: a.approval_id, scorecard_id: sc.scorecard_id, decision, approver_ref: approverRef, world_result_hash: wrh, decided_at: decidedAt }),
    );
    this.db.transaction(() => {
      if (nullifier && !consumeNullifier(this.db, nullifier, `${a.world_action}:${sc.scorecard_id}`, decidedAt)) {
        throw new ApiError(401, "world_verification_failed", "World proof was already used (replay)");
      }
      this.repo.updateApproval(a.approval_id, {
        status: decision === "approve" ? "approved" : "denied",
        approver_employee_id: p.employee_id,
        comment: body.comment ?? null,
        proof_hash: proofHash,
        world_result_hash: wrh,
        decided_at: decidedAt,
      });
      this.repo.update(sc.scorecard_id, { status: decision === "approve" ? "approved" : "denied" });
      this.audit.append(decidedAt, p.persona_id, decision === "approve" ? "approval.approved" : "approval.denied", a.approval_id, {
        scorecard_id: sc.scorecard_id,
        approval_proof_hash: proofHash,
        world_result_hash: wrh,
      });
    })();
    return toApproval(this.repo.approval(a.approval_id)!);
  }

  cancelApproval(p: Persona, id: string): Approval {
    const { a, sc } = this.approvalVisible(p, id);
    this.approvable(p, sc);
    if (a.status !== "pending") throw errors.invalidState("Approval is not pending", { status: a.status });
    const now = this.now();
    this.db.transaction(() => {
      this.repo.updateApproval(a.approval_id, { status: "cancelled", decided_at: now });
      this.repo.update(sc.scorecard_id, { status: "draft", approval_id: null });
      this.audit.append(now, p.persona_id, "approval.cancelled", a.approval_id, { scorecard_id: sc.scorecard_id });
    })();
    return toApproval(this.repo.approval(a.approval_id)!);
  }
}
