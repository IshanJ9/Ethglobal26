import type { DB } from "./index.ts";

export interface ScorecardRow {
  scorecard_id: string;
  employee_id: string;
  cycle_id: string;
  version: number;
  supersedes_id: string | null;
  reason: string | null;
  status: string;
  result_json: string;
  evidence_ids_json: string;
  evidence_root: string | null;
  score_commitment: string | null;
  score_salt_enc: string | null;
  score_object_json: string | null;
  subject_id: string | null;
  approval_id: string | null;
  needs_revision: number;
  attestation_json: string | null;
  created_at: string;
}

export interface ApprovalRow {
  approval_id: string;
  scorecard_id: string;
  status: string;
  challenge: string;
  nonce: string;
  world_action: string;
  approver_employee_id: string | null;
  comment: string | null;
  proof_hash: string | null;
  world_result_hash: string | null;
  created_at: string;
  decided_at: string | null;
}

const insertRow = (db: DB, table: string, r: object) => {
  const cols = Object.keys(r);
  db.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(r);
};
const updateRow = (db: DB, table: string, key: string, id: string, patch: object) => {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE ${key} = @__id`).run({ ...patch, __id: id });
};

export const scorecardRepo = (db: DB) => ({
  /** Latest non-revoked FINAL scorecard (approved|attested) of a cycle, for carry-forward. */
  latestFinal(employeeId: string, cycleId: string): { scorecard_id: string; result_json: string } | undefined {
    return db
      .prepare(
        `SELECT scorecard_id, result_json FROM scorecards
          WHERE employee_id = ? AND cycle_id = ? AND status IN ('approved','attested')
          ORDER BY version DESC LIMIT 1`,
      )
      .get(employeeId, cycleId) as { scorecard_id: string; result_json: string } | undefined;
  },
  get(id: string): ScorecardRow | undefined {
    return db.prepare("SELECT * FROM scorecards WHERE scorecard_id = ?").get(id) as ScorecardRow | undefined;
  },
  list(f: { employeeIds: string[]; cycleId?: string }): ScorecardRow[] {
    if (!f.employeeIds.length) return [];
    const where = [`employee_id IN (${f.employeeIds.map(() => "?").join(",")})`];
    const args: unknown[] = [...f.employeeIds];
    if (f.cycleId) (where.push("cycle_id = ?"), args.push(f.cycleId));
    return db.prepare(`SELECT * FROM scorecards WHERE ${where.join(" AND ")} ORDER BY employee_id, cycle_id, version`).all(...args) as ScorecardRow[];
  },
  maxVersion(employeeId: string, cycleId: string): number {
    return (db.prepare("SELECT MAX(version) FROM scorecards WHERE employee_id = ? AND cycle_id = ?").pluck().get(employeeId, cycleId) as number | null) ?? 0;
  },
  /** The currently attested (non-superseded) version, if any. */
  attested(employeeId: string, cycleId: string): ScorecardRow | undefined {
    return db
      .prepare("SELECT * FROM scorecards WHERE employee_id = ? AND cycle_id = ? AND status = 'attested' ORDER BY version DESC LIMIT 1")
      .get(employeeId, cycleId) as ScorecardRow | undefined;
  },
  byAttestationId(attId: number): ScorecardRow | undefined {
    return db
      .prepare("SELECT s.* FROM scorecards s JOIN attestations a ON a.scorecard_id = s.scorecard_id WHERE a.attestation_id = ?")
      .get(attId) as ScorecardRow | undefined;
  },
  insert: (r: ScorecardRow) => insertRow(db, "scorecards", r),
  update: (id: string, patch: Partial<ScorecardRow>) => updateRow(db, "scorecards", "scorecard_id", id, patch),

  // ---- approvals ----
  approval(id: string): ApprovalRow | undefined {
    return db.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(id) as ApprovalRow | undefined;
  },
  pendingApproval(scorecardId: string): ApprovalRow | undefined {
    return db.prepare("SELECT * FROM approvals WHERE scorecard_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(scorecardId) as
      | ApprovalRow
      | undefined;
  },
  insertApproval: (r: ApprovalRow) => insertRow(db, "approvals", r),
  updateApproval: (id: string, patch: Partial<ApprovalRow>) => updateRow(db, "approvals", "approval_id", id, patch),
});
export type ScorecardRepo = ReturnType<typeof scorecardRepo>;

export interface BatchRow {
  batch_id: string;
  numeric_id: number;
  root: string;
  count: number;
  tx_hash: string;
  chain_mode: string;
  anchored_at: string;
}

export const chainRepo = (db: DB) => ({
  maxBatchNumeric(): number {
    return (db.prepare("SELECT MAX(numeric_id) FROM batches").pluck().get() as number | null) ?? 0;
  },
  unanchoredEvidence(): Array<{ evidence_id: string; commitment: string }> {
    return db
      .prepare("SELECT evidence_id, commitment FROM evidence WHERE batch_id IS NULL AND status NOT IN ('shredded','rejected') ORDER BY seq")
      .all() as Array<{ evidence_id: string; commitment: string }>;
  },
  insertBatch(b: BatchRow, items: Array<{ evidence_id: string; leaf_index: number; proof: string[] }>) {
    insertRow(db, "batches", b);
    const ins = db.prepare("INSERT INTO batch_items (batch_id, evidence_id, leaf_index, proof_json) VALUES (?, ?, ?, ?)");
    const upd = db.prepare("UPDATE evidence SET batch_id = ? WHERE evidence_id = ?");
    for (const i of items) {
      ins.run(b.batch_id, i.evidence_id, i.leaf_index, JSON.stringify(i.proof));
      upd.run(b.batch_id, i.evidence_id);
    }
  },
  batch(id: string): BatchRow | undefined {
    return db.prepare("SELECT * FROM batches WHERE batch_id = ?").get(id) as BatchRow | undefined;
  },
  batchEvidenceIds(id: string): string[] {
    return db.prepare("SELECT evidence_id FROM batch_items WHERE batch_id = ? ORDER BY leaf_index").pluck().all(id) as string[];
  },
  insertAttestation(a: { attestation_id: number; scorecard_id: string; version: number; supersedes_id: number | null; tx_hash: string; chain_mode: string; attested_at: string }) {
    insertRow(db, "attestations", a);
  },
  /** Last vault tx per (subject, cycle) for the payout read-model. */
  setLastPayoutTx(key: string, tx: string) {
    db.prepare(
      `INSERT INTO payouts (scorecard_id, status, payee, target_bonus, entitlement, paid, held, forfeited, overpaid, maturity_at, last_tx)
       VALUES (?, '', '', '0', '0', '0', '0', '0', '0', NULL, ?) ON CONFLICT(scorecard_id) DO UPDATE SET last_tx = excluded.last_tx`,
    ).run(key, tx);
  },
  lastPayoutTx(key: string): string | null {
    return (db.prepare("SELECT last_tx FROM payouts WHERE scorecard_id = ?").pluck().get(key) as string | undefined) ?? null;
  },
});
export type ChainRepo = ReturnType<typeof chainRepo>;
