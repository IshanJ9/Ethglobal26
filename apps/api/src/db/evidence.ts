import type { DB } from "./index.ts";

export interface EvidenceRow {
  evidence_id: string;
  employee_id: string;
  cycle_id: string;
  source: string;
  kind: string;
  ref: string | null;
  status: string;
  status_at_ingest: string;
  observed_at: string;
  observations_json: string;
  severity: string | null;
  self_introduced: number;
  share_bps: number;
  flags_json: string;
  reverts_evidence_id: string | null;
  supersedes_evidence_id: string | null;
  claim_id: string | null;
  commitment: string;
  batch_id: string | null;
  seq: number;
  prev_hash: string;
  event_hash: string;
  created_at: string;
  shredded_at: string | null;
  // joined
  replica_root?: string | null;
  replica_status?: string | null;
  proof_json?: string | null;
}

const SELECT = `SELECT e.*, s.replica_root, s.replica_status, bi.proof_json
  FROM evidence e
  LEFT JOIN evidence_secrets s ON s.evidence_id = e.evidence_id
  LEFT JOIN batch_items bi ON bi.batch_id = e.batch_id AND bi.evidence_id = e.evidence_id`;

export const evidenceRepo = (db: DB) => ({
  get(id: string): EvidenceRow | undefined {
    return db.prepare(`${SELECT} WHERE e.evidence_id = ?`).get(id) as EvidenceRow | undefined;
  },
  byRef(source: string, kind: string, ref: string): EvidenceRow | undefined {
    return db.prepare(`${SELECT} WHERE e.source = ? AND e.kind = ? AND e.ref = ?`).get(source, kind, ref) as EvidenceRow | undefined;
  },
  /** Revert targets are looked up by ref alone, within the same employee. */
  byRefForEmployee(employeeId: string, ref: string): EvidenceRow | undefined {
    return db.prepare(`${SELECT} WHERE e.employee_id = ? AND e.ref = ? ORDER BY e.seq LIMIT 1`).get(employeeId, ref) as EvidenceRow | undefined;
  },
  list(f: { employeeIds: string[]; cycleId?: string; status?: string }): EvidenceRow[] {
    if (!f.employeeIds.length) return [];
    const where = [`e.employee_id IN (${f.employeeIds.map(() => "?").join(",")})`];
    const args: unknown[] = [...f.employeeIds];
    if (f.cycleId) (where.push("e.cycle_id = ?"), args.push(f.cycleId));
    if (f.status) (where.push("e.status = ?"), args.push(f.status));
    return db.prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY e.seq`).all(...args) as EvidenceRow[];
  },
  forEmployeeCycle(employeeId: string, cycleId: string): EvidenceRow[] {
    return db.prepare(`${SELECT} WHERE e.employee_id = ? AND e.cycle_id = ? ORDER BY e.seq`).all(employeeId, cycleId) as EvidenceRow[];
  },
  lastLink(): { seq: number; event_hash: string } | undefined {
    return db.prepare("SELECT seq, event_hash FROM evidence ORDER BY seq DESC LIMIT 1").get() as { seq: number; event_hash: string } | undefined;
  },
  insert(r: Omit<EvidenceRow, "replica_root" | "replica_status" | "proof_json">, secrets: { dek_wrapped: string; salt_enc: string; payload_enc: string }) {
    db.prepare(
      `INSERT INTO evidence (evidence_id, employee_id, cycle_id, source, kind, ref, status, status_at_ingest, observed_at, observations_json,
         severity, self_introduced, share_bps, flags_json, reverts_evidence_id, supersedes_evidence_id, claim_id, commitment, batch_id,
         seq, prev_hash, event_hash, created_at, shredded_at)
       VALUES (@evidence_id, @employee_id, @cycle_id, @source, @kind, @ref, @status, @status_at_ingest, @observed_at, @observations_json,
         @severity, @self_introduced, @share_bps, @flags_json, @reverts_evidence_id, @supersedes_evidence_id, @claim_id, @commitment, @batch_id,
         @seq, @prev_hash, @event_hash, @created_at, @shredded_at)`,
    ).run(r);
    db.prepare(
      "INSERT INTO evidence_secrets (evidence_id, dek_wrapped, salt_enc, payload_enc, replica_root, replica_status) VALUES (?, ?, ?, ?, NULL, 'none')",
    ).run(r.evidence_id, secrets.dek_wrapped, secrets.salt_enc, secrets.payload_enc);
  },
  setStatus(id: string, status: string) {
    db.prepare("UPDATE evidence SET status = ? WHERE evidence_id = ?").run(status, id);
  },
  setRevertLink(id: string, targetId: string) {
    db.prepare("UPDATE evidence SET reverts_evidence_id = ? WHERE evidence_id = ?").run(targetId, id);
  },
  secrets(id: string): { dek_wrapped: string | null; salt_enc: string | null; payload_enc: string | null } | undefined {
    return db.prepare("SELECT dek_wrapped, salt_enc, payload_enc FROM evidence_secrets WHERE evidence_id = ?").get(id) as any;
  },
  setReplica(id: string, status: string, root: string | null) {
    db.prepare("UPDATE evidence_secrets SET replica_status = ?, replica_root = ? WHERE evidence_id = ? AND replica_status != 'shredded'").run(status, root, id);
  },
  /** Crypto-shred: destroy the record key, ciphertexts, salt and replica pointer. Commitment + leaf remain. */
  shred(id: string, at: string) {
    db.prepare("UPDATE evidence_secrets SET dek_wrapped = NULL, salt_enc = NULL, payload_enc = NULL, replica_root = NULL, replica_status = 'shredded' WHERE evidence_id = ?").run(id);
    db.prepare("UPDATE evidence SET status = 'shredded', shredded_at = ? WHERE evidence_id = ?").run(at, id);
  },
  /** Ingest events in chain order, for hash-chain verification. */
  chain(): Iterable<Pick<EvidenceRow, "seq" | "evidence_id" | "commitment" | "status_at_ingest" | "prev_hash" | "event_hash">> {
    return db.prepare("SELECT seq, evidence_id, commitment, status_at_ingest, prev_hash, event_hash FROM evidence ORDER BY seq").iterate() as any;
  },
  /** Flag attested/approved scorecards that counted this evidence (a human then calls /revise). Returns ids. */
  flagScorecardsUsing(evidenceId: string): string[] {
    const ids = db
      .prepare(
        `SELECT scorecard_id FROM scorecards WHERE status IN ('attested','approved')
           AND EXISTS (SELECT 1 FROM json_each(scorecards.evidence_ids_json) WHERE value = ?)`,
      )
      .pluck()
      .all(evidenceId) as string[];
    const u = db.prepare("UPDATE scorecards SET needs_revision = 1 WHERE scorecard_id = ?");
    for (const id of ids) u.run(id);
    return ids;
  },
});
export type EvidenceRepo = ReturnType<typeof evidenceRepo>;
