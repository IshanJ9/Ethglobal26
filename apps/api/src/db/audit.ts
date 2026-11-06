// Append-only, hash-chained audit log: event_hash = eventHash(prev, {seq, at, actor, action, subject, detail}).
// Detail must contain ids/hashes/codes only - never raw text, salts, tokens, keys or World proofs.
import { eventHash, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import type { DB } from "./index.ts";

export type AuditEntry = components["schemas"]["AuditEntry"];
const ZERO = ("0x" + "00".repeat(32)) as Hex;

const row = (r: any): AuditEntry => ({
  seq: r.seq,
  at: r.at,
  actor: r.actor,
  action: r.action,
  subject: r.subject,
  detail: JSON.parse(r.detail_json),
  prev_hash: r.prev_hash,
  event_hash: r.event_hash,
});

export const auditRepo = (db: DB) => ({
  append(at: string, actor: string, action: string, subject: string, detail: Record<string, unknown> = {}): AuditEntry {
    const last = db.prepare("SELECT seq, event_hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; event_hash: Hex }
      | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prev = last?.event_hash ?? ZERO;
    const h = eventHash(prev, { seq, at, actor, action, subject, detail });
    db.prepare(
      "INSERT INTO audit_log (seq, at, actor, action, subject, detail_json, prev_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(seq, at, actor, action, subject, JSON.stringify(detail), prev, h);
    return { seq, at, actor, action, subject, detail, prev_hash: prev, event_hash: h };
  },

  /** Ascending from `after` (exclusive). Optional actor filter. */
  list(opts: { after?: number; limit: number; actors?: string[] }): AuditEntry[] {
    const after = opts.after ?? 0;
    if (opts.actors) {
      if (!opts.actors.length) return [];
      const qs = opts.actors.map(() => "?").join(",");
      return db
        .prepare(`SELECT * FROM audit_log WHERE seq > ? AND actor IN (${qs}) ORDER BY seq LIMIT ?`)
        .all(after, ...opts.actors, opts.limit)
        .map(row);
    }
    return db.prepare("SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?").all(after, opts.limit).map(row);
  },

  /** Recomputes every link. Returns the first broken seq, or null if intact. */
  verifyChain(): number | null {
    let prev = ZERO;
    for (const r of db.prepare("SELECT * FROM audit_log ORDER BY seq").iterate() as Iterable<any>) {
      const core = { seq: r.seq, at: r.at, actor: r.actor, action: r.action, subject: r.subject, detail: JSON.parse(r.detail_json) };
      if (r.prev_hash !== prev || eventHash(prev, core) !== r.event_hash) return r.seq;
      prev = r.event_hash;
    }
    return null;
  },
});
export type AuditRepo = ReturnType<typeof auditRepo>;
