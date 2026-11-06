// CR-004: read evidence back out of the encryption vault for the reasoning packet.
// Order of preference: the 0G Storage replica (live) / local replica (mock) by its root, else the org DB copy.
// Every payload is decrypted with its record key and its commitment is RECOMPUTED and compared with the
// ledger commitment, so the reasoning provably uses exactly the data that was committed (and anchored).
import { commit, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import type { EvidenceRepo, EvidenceRow } from "../db/evidence.ts";
import type { Envelope } from "../ledger/envelope.ts";
import type { ReplicaStore } from "../replica/replica.ts";

export type VaultReport = components["schemas"]["VaultReport"];
export interface VaultPayload {
  core?: { observations?: Array<{ metric_key: string; value: number }>; [k: string]: unknown };
  raw?: Record<string, unknown> | null;
  excerpt?: string;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms} ms`)), ms))]);

export class VaultReader {
  constructor(
    private readonly evidence: EvidenceRepo,
    private readonly envelope: Envelope,
    private readonly store: ReplicaStore,
    private readonly opts: { timeoutMs: number; concurrency: number; log?: (m: string, d?: Record<string, unknown>) => void } = { timeoutMs: 30_000, concurrency: 4 },
  ) {}

  async read(rows: EvidenceRow[]): Promise<{ report: VaultReport; payloads: Map<string, VaultPayload> }> {
    const payloads = new Map<string, VaultPayload>();
    const items: VaultReport["items"] = new Array(rows.length);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        items[i] = await this.one(rows[i], payloads);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, rows.length) }, worker));
    return {
      payloads,
      report: {
        items_total: items.length,
        from_0g: items.filter((x) => x.read_from === "0g_storage" || x.read_from === "local_replica").length,
        from_org_db: items.filter((x) => x.read_from === "org_db").length,
        commitments_matched: items.filter((x) => x.commitment_ok === true).length,
        commitments_failed: items.filter((x) => x.commitment_ok === false).length,
        store_mode: this.store.mode,
        items,
      },
    };
  }

  private async one(r: EvidenceRow, payloads: Map<string, VaultPayload>): Promise<VaultReport["items"][number]> {
    const base = { evidence_id: r.evidence_id, employee_id: r.employee_id, source: r.source, kind: r.kind, replica_root: r.replica_root ?? null };
    const s = this.evidence.secrets(r.evidence_id);
    if (!s?.dek_wrapped || !s.salt_enc) return { ...base, read_from: "shredded", commitment_ok: null };

    let sealed: string | null = null;
    let readFrom: "0g_storage" | "local_replica" | "org_db" = "org_db";
    if (r.replica_root && r.replica_status === "stored") {
      try {
        const bytes = await withTimeout(this.store.get(r.replica_root), this.opts.timeoutMs);
        sealed = Buffer.from(bytes).toString("utf8");
        readFrom = this.store.mode === "live" ? "0g_storage" : "local_replica";
      } catch (e) {
        this.opts.log?.("vault read from replica failed; using the org DB copy", { evidence_id: r.evidence_id, error: (e as Error).message.slice(0, 160) });
      }
    }
    if (sealed === null) sealed = s.payload_enc;
    if (!sealed) return { ...base, read_from: "shredded", commitment_ok: null };

    try {
      const dek = this.envelope.unwrap(s.dek_wrapped);
      const payload = JSON.parse(this.envelope.decrypt(dek, sealed)) as VaultPayload;
      const salt = this.envelope.decrypt(dek, s.salt_enc) as Hex;
      // Connector items commit to `core`; claim items commit to the payload itself ({excerpt}).
      const recomputed = payload.core !== undefined ? commit(salt, payload.core) : commit(salt, payload);
      payloads.set(r.evidence_id, payload);
      return { ...base, read_from: readFrom, commitment_ok: recomputed === r.commitment };
    } catch (e) {
      this.opts.log?.("vault payload could not be opened", { evidence_id: r.evidence_id, error: (e as Error).message.slice(0, 160) });
      return { ...base, read_from: readFrom, commitment_ok: false };
    }
  }
}
