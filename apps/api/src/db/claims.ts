import type { DB } from "./index.ts";

export interface ClaimRow {
  claim_id: string;
  employee_id: string;
  cycle_id: string;
  kra_id: string;
  state: string;
  body_json: string;
  excerpt: string;
  cosigner_address: string;
  cosigner_label: string;
  ai_flags_json: string;
  inference_json: string | null;
  frozen_at: string | null;
  typed_data_json: string | null;
  digest: string | null;
  claim_commitment: string | null;
  evidence_commitment: string | null;
  nonce: number | null;
  deadline: number | null;
  employee_sig: string | null;
  cosigner_sig: string | null;
  evidence_id: string | null;
  decline_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrantRow {
  grant_id: string;
  claim_id: string;
  auth_method: string;
  token_sha256: string;
  world_action: string | null;
  expires_at: string;
  created_at: string;
  closed_at: string | null;
  closed_reason: string | null;
}

export const claimRepo = (db: DB) => ({
  get(id: string): ClaimRow | undefined {
    return db.prepare("SELECT * FROM claims WHERE claim_id = ?").get(id) as ClaimRow | undefined;
  },
  list(f: { employeeIds: string[]; cycleId?: string; state?: string }): ClaimRow[] {
    if (!f.employeeIds.length) return [];
    const where = [`employee_id IN (${f.employeeIds.map(() => "?").join(",")})`];
    const args: unknown[] = [...f.employeeIds];
    if (f.cycleId) (where.push("cycle_id = ?"), args.push(f.cycleId));
    if (f.state) (where.push("state = ?"), args.push(f.state));
    return db.prepare(`SELECT * FROM claims WHERE ${where.join(" AND ")} ORDER BY created_at, claim_id`).all(...args) as ClaimRow[];
  },
  insert(r: ClaimRow) {
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO claims (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(r);
  },
  update(id: string, patch: Partial<ClaimRow>) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    db.prepare(`UPDATE claims SET ${cols.map((c) => `${c} = @${c}`).join(", ")} WHERE claim_id = @__id`).run({ ...patch, __id: id });
  },
  saveSecrets(id: string, s: { dek_wrapped: string; claim_salt_enc: string; evidence_salt_enc: string }) {
    db.prepare(
      `INSERT INTO claim_secrets (claim_id, dek_wrapped, claim_salt_enc, evidence_salt_enc) VALUES (?, ?, ?, ?)
       ON CONFLICT(claim_id) DO UPDATE SET dek_wrapped = excluded.dek_wrapped, claim_salt_enc = excluded.claim_salt_enc, evidence_salt_enc = excluded.evidence_salt_enc`,
    ).run(id, s.dek_wrapped, s.claim_salt_enc, s.evidence_salt_enc);
  },
  secrets(id: string): { dek_wrapped: string | null; claim_salt_enc: string | null; evidence_salt_enc: string | null } | undefined {
    return db.prepare("SELECT dek_wrapped, claim_salt_enc, evidence_salt_enc FROM claim_secrets WHERE claim_id = ?").get(id) as any;
  },

  // ---- grants ----
  insertGrant(g: GrantRow) {
    const cols = Object.keys(g);
    db.prepare(`INSERT INTO cosign_grants (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`).run(g);
  },
  grantByTokenHash(h: string): GrantRow | undefined {
    return db.prepare("SELECT * FROM cosign_grants WHERE token_sha256 = ?").get(h) as GrantRow | undefined;
  },
  openGrants(claimId: string): GrantRow[] {
    return db.prepare("SELECT * FROM cosign_grants WHERE claim_id = ? AND closed_at IS NULL").all(claimId) as GrantRow[];
  },
  closeGrant(grantId: string, at: string, reason: string) {
    db.prepare("UPDATE cosign_grants SET closed_at = ?, closed_reason = ? WHERE grant_id = ? AND closed_at IS NULL").run(at, reason, grantId);
  },
});
export type ClaimRepo = ReturnType<typeof claimRepo>;
