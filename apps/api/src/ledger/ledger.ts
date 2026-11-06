// Evidence ledger (AGENT_A 3.1): salted commitments, global hash chain, envelope encryption,
// idempotent ingest on (source, kind, ref), promotion rules, revert handling.
import { commit, eventHash, randomSalt, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { errors } from "../errors.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { EvidenceRepo, EvidenceRow } from "../db/evidence.ts";
import type { OrgRepo } from "../db/org.ts";
import type { DB } from "../db/index.ts";
import { iso, newId, type Clock } from "../util.ts";
import type { Envelope } from "./envelope.ts";

export type EvidenceItem = components["schemas"]["EvidenceItem"];
export type EvidenceIngest = components["schemas"]["EvidenceIngest"];
export type EvidenceStatus = components["schemas"]["EvidenceStatus"];

const ZERO = ("0x" + "00".repeat(32)) as Hex;
/** System-of-record connectors are auto-verified at ingest (ENGINE.md section 3). */
export const CONNECTOR_SOURCES = new Set(["github", "tickets", "crm", "hris"]);

export interface IngestOptions {
  actor: string;
  /** Force a status (dev shortcut s2 / claim submit). Otherwise promotion rules apply. */
  status?: EvidenceStatus;
  claimId?: string;
  /** Pre-computed commitment and its salt (claims commit to {excerpt} with the claim's evidence salt). */
  commitment?: Hex;
  salt?: Hex;
  /** Plaintext to keep encrypted alongside (defaults to the core + raw payload). */
  payload?: unknown;
}

export function toEvidenceItem(r: EvidenceRow): EvidenceItem {
  return {
    evidence_id: r.evidence_id,
    employee_id: r.employee_id,
    cycle_id: r.cycle_id,
    source: r.source as EvidenceItem["source"],
    kind: r.kind,
    ref: r.ref,
    status: r.status as EvidenceStatus,
    observed_at: r.observed_at,
    observations: JSON.parse(r.observations_json),
    severity: (r.severity ?? null) as EvidenceItem["severity"],
    self_introduced: !!r.self_introduced,
    share_bps: r.share_bps,
    links: {
      reverts_evidence_id: r.reverts_evidence_id,
      supersedes_evidence_id: r.supersedes_evidence_id,
      claim_id: r.claim_id,
    },
    commitment: r.commitment,
    batch_id: r.batch_id,
    merkle_proof: r.proof_json ? JSON.parse(r.proof_json) : null,
    seq: r.seq,
    prev_hash: r.prev_hash,
    event_hash: r.event_hash,
    replica: { zg_root: r.replica_root ?? null, status: (r.replica_status ?? "none") as "none" },
  };
}

/** The committed value for connector items (HASHING.md section 4): optional fields never omitted. */
export function evidenceCore(i: EvidenceIngest) {
  return {
    source: i.source,
    kind: i.kind,
    ref: i.ref ?? null,
    observed_at: i.observed_at,
    observations: i.observations.map((o) => ({ metric_key: o.metric_key, value: o.value })),
    severity: i.severity ?? null,
    self_introduced: i.self_introduced ?? false,
    share_bps: i.share_bps ?? 10000,
  };
}

export class Ledger {
  constructor(
    private readonly db: DB,
    private readonly repo: EvidenceRepo,
    private readonly org: OrgRepo,
    private readonly audit: AuditRepo,
    private readonly envelope: Envelope,
    private readonly clock: Clock,
  ) {}

  /** Returns the stored item and whether it was newly created (false = idempotent duplicate). */
  ingest(input: EvidenceIngest, opts: IngestOptions): { item: EvidenceItem; created: boolean } {
    if (!this.org.employee(input.employee_id)) throw errors.validation(`Unknown employee_id ${input.employee_id}`);
    if (!this.org.cycle(input.cycle_id)) throw errors.validation(`Unknown cycle_id ${input.cycle_id}`);
    for (const o of input.observations) {
      if (!Number.isSafeInteger(o.value)) throw errors.validation("Observation values must be safe integers", { metric_key: o.metric_key });
    }

    return this.db.transaction(() => {
      if (input.ref) {
        const dup = this.repo.byRef(input.source, input.kind, input.ref);
        if (dup) return { item: toEvidenceItem(dup), created: false };
      }

      let revertTarget: EvidenceRow | undefined;
      if (input.reverts_ref) {
        revertTarget = this.repo.byRefForEmployee(input.employee_id, input.reverts_ref);
        if (!revertTarget) throw errors.validation(`reverts_ref ${input.reverts_ref} does not match any evidence of this employee`);
      }

      const flags: string[] = [];
      let status: EvidenceStatus = opts.status ?? (CONNECTOR_SOURCES.has(input.source) ? "verified" : "unverified");
      // n17: severity must be set by someone other than the fixer.
      const raw = (input.raw ?? {}) as Record<string, unknown>;
      if (input.severity && raw.severity_set_by && raw.severity_set_by === input.employee_id) {
        flags.push("severity_set_by_fixer");
        status = "unverified";
      }

      const core = evidenceCore(input);
      const salt = opts.salt ?? randomSalt();
      const commitment = opts.commitment ?? commit(salt, core);
      const last = this.repo.lastLink();
      const seq = (last?.seq ?? 0) + 1;
      const prev = (last?.event_hash ?? ZERO) as Hex;
      const evidenceId = newId("evd");
      const link = eventHash(prev, { seq, evidence_id: evidenceId, commitment, status });

      const { dek, wrapped } = this.envelope.newDek();
      const payload = opts.payload ?? { core, raw: input.raw ?? null };
      this.repo.insert(
        {
          evidence_id: evidenceId,
          employee_id: input.employee_id,
          cycle_id: input.cycle_id,
          source: input.source,
          kind: input.kind,
          ref: input.ref ?? null,
          status,
          status_at_ingest: status,
          observed_at: input.observed_at,
          observations_json: JSON.stringify(core.observations),
          severity: input.severity ?? null,
          self_introduced: core.self_introduced ? 1 : 0,
          share_bps: core.share_bps,
          flags_json: JSON.stringify(flags),
          reverts_evidence_id: revertTarget?.evidence_id ?? null,
          supersedes_evidence_id: null,
          claim_id: opts.claimId ?? null,
          commitment,
          batch_id: null,
          seq,
          prev_hash: prev,
          event_hash: link,
          created_at: iso(this.clock.now()),
          shredded_at: null,
        },
        {
          dek_wrapped: wrapped,
          salt_enc: this.envelope.encrypt(dek, salt),
          payload_enc: this.envelope.encrypt(dek, JSON.stringify(payload)),
        },
      );
      const at = iso(this.clock.now());
      this.audit.append(at, opts.actor, "evidence.ingested", evidenceId, { seq, commitment, status, source: input.source, kind: input.kind, flags });

      if (revertTarget) {
        this.repo.setStatus(revertTarget.evidence_id, "reverted");
        const flagged = this.repo.flagScorecardsUsing(revertTarget.evidence_id);
        this.audit.append(at, opts.actor, "evidence.reverted", revertTarget.evidence_id, {
          by: evidenceId,
          from_status: revertTarget.status,
          scorecards_needing_revision: flagged,
        });
      }
      return { item: toEvidenceItem(this.repo.get(evidenceId)!), created: true };
    })();
  }

  setStatus(evidenceId: string, status: EvidenceStatus, actor: string, reason: string) {
    const r = this.repo.get(evidenceId);
    if (!r) throw errors.notFound("Evidence not found");
    if (r.status === status) return;
    this.repo.setStatus(evidenceId, status);
    this.audit.append(iso(this.clock.now()), actor, "evidence.status_changed", evidenceId, { from: r.status, to: status, reason });
  }

  /** HR erasure (F5). Designed for erasure via crypto-shredding; verification of the leaf still works. */
  shred(evidenceId: string, actor: string): EvidenceItem {
    const r = this.repo.get(evidenceId);
    if (!r) throw errors.notFound("Evidence not found");
    if (r.status !== "shredded") {
      const at = iso(this.clock.now());
      this.db.transaction(() => {
        this.repo.shred(evidenceId, at);
        const flagged = this.repo.flagScorecardsUsing(evidenceId);
        this.audit.append(at, actor, "evidence.shredded", evidenceId, { from_status: r.status, commitment: r.commitment, scorecards_needing_revision: flagged });
      })();
    }
    return toEvidenceItem(this.repo.get(evidenceId)!);
  }

  get(id: string): EvidenceItem | undefined {
    const r = this.repo.get(id);
    return r ? toEvidenceItem(r) : undefined;
  }

  /** Recomputes the evidence hash chain. Returns the first broken seq or null. */
  verifyChain(): number | null {
    let prev = ZERO as string;
    for (const r of this.repo.chain()) {
      const h = eventHash(prev as Hex, { seq: r.seq, evidence_id: r.evidence_id, commitment: r.commitment, status: r.status_at_ingest });
      if (r.prev_hash !== prev || h !== r.event_hash) return r.seq;
      prev = r.event_hash;
    }
    return null;
  }
}
