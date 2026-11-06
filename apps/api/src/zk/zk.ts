// Zero-knowledge score proofs (Groth16, circuit packages/zk/circuits/score_threshold.circom).
// The COMPANY commits: commitment = Poseidon(score_bps, salt, binding), binding = keccak256(scorecard_id) >> 8,
// and anchors it on Arc (registry.anchorBatch, batch ids >= 2e9) so the employee cannot choose their own number.
// The EMPLOYEE (only them) fetches the witness and proves "score >= threshold" in their browser; anyone verifies
// the proof locally and against ScoreThresholdVerifier on Arc, and checks the anchored commitment.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { keccakUtf8, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { errors } from "../errors.ts";
import { canApprove, canView, isInternal } from "../auth/auth.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { DB } from "../db/index.ts";
import type { OrgRepo, Persona } from "../db/org.ts";
import type { ScorecardRepo } from "../db/scorecards.ts";
import type { ChainClient } from "../chain/types.ts";
import type { Config } from "../config.ts";
import type { Envelope } from "../ledger/envelope.ts";
import { iso, type Clock } from "../util.ts";

export type ZkCommitment = components["schemas"]["ZkCommitment"];
export type ZkWitness = components["schemas"]["ZkWitness"];

const ZK_BATCH_BASE = 2_000_000_000; // never collides with evidence (sequential) or review (>= 1e9) anchors
const BN254_R = 21888242871839275222246108745616613508584939886627720465963307183398007234321n;
const require = createRequire(import.meta.url);

let poseidonP: Promise<any> | null = null;
const poseidon = () => (poseidonP ??= (require("circomlibjs") as any).buildPoseidon());

export const bindingOf = (scorecardId: string): bigint => BigInt(keccakUtf8(scorecardId)) >> 8n;

export async function poseidonCommit(score: bigint, salt: bigint, binding: bigint): Promise<bigint> {
  const p = await poseidon();
  return p.F.toObject(p([score, salt, binding])) as bigint;
}

interface Row {
  scorecard_id: string;
  employee_id: string;
  score_bps: number;
  commitment: string;
  binding: string;
  dek_wrapped: string;
  salt_enc: string;
  anchor_json: string;
  created_at: string;
}

export class ZkService {
  constructor(
    private readonly db: DB,
    private readonly scorecards: ScorecardRepo,
    private readonly org: OrgRepo,
    private readonly envelope: Envelope,
    private readonly chain: ChainClient,
    private readonly audit: AuditRepo,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly exclusive: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
  ) {}

  private row(scorecardId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM zk_commitments WHERE scorecard_id = ?").get(scorecardId) as Row | undefined;
  }

  private toApi(r: Row): ZkCommitment {
    const a = JSON.parse(r.anchor_json);
    return {
      scorecard_id: r.scorecard_id,
      commitment: r.commitment,
      commitment_hex: ("0x" + BigInt(r.commitment).toString(16).padStart(64, "0")) as Hex,
      binding: r.binding,
      circuit: "score_threshold (Groth16, BN254)",
      numeric_batch_id: a.numeric_batch_id,
      tx_hash: a.tx_hash,
      chain_mode: a.chain_mode,
      explorer_url: a.explorer_url,
      verifier_address: this.config.ZK_VERIFIER_ADDRESS ?? null,
      registry_address: this.config.REGISTRY_ADDRESS,
      chain_id: this.config.CHAIN_ID,
      created_at: r.created_at,
    };
  }

  private scorecardFor(p: Persona, id: string) {
    const sc = this.scorecards.get(id);
    if (!sc || !isInternal(p) || !canView(p, this.org.employee(sc.employee_id))) throw errors.notFound("Scorecard not found");
    return sc;
  }

  get(p: Persona, scorecardId: string): ZkCommitment {
    this.scorecardFor(p, scorecardId);
    const r = this.row(scorecardId);
    if (!r) throw errors.notFound("No ZK commitment for this scorecard yet");
    return this.toApi(r);
  }

  /** HR or the employee's manager commits the score (approved or attested scorecards only). Idempotent. */
  async commit(p: Persona, scorecardId: string): Promise<ZkCommitment> {
    const sc = this.scorecardFor(p, scorecardId);
    const emp = this.org.employee(sc.employee_id)!;
    if (!canApprove(p, emp)) throw errors.forbidden("Only HR or the employee's manager can commit a score for ZK proofs");
    if (!["approved", "attested"].includes(sc.status)) throw errors.invalidState("Only approved or attested scorecards can be committed", { status: sc.status });
    return this.exclusive(async () => {
      const existing = this.row(scorecardId);
      if (existing) return this.toApi(existing);
      const score = BigInt((JSON.parse(sc.result_json) as { score_bps: number }).score_bps);
      const salt = BigInt("0x" + randomBytes(31).toString("hex")) % BN254_R;
      const binding = bindingOf(scorecardId);
      const commitment = await poseidonCommit(score, salt, binding);
      const hex = ("0x" + commitment.toString(16).padStart(64, "0")) as Hex;
      let numeric = ZK_BATCH_BASE + ((this.db.prepare("SELECT COUNT(*) FROM zk_commitments").pluck().get() as number) ?? 0) + 1;
      const zero = "0x" + "00".repeat(32);
      while ((await this.chain.batchRoot(BigInt(numeric))) !== zero) numeric++;
      const { txHash } = await this.chain.anchorBatch(hex, BigInt(numeric), 1);
      const base = this.config.EXPLORER_BASE_URL?.replace(/\/$/, "");
      const anchor = { numeric_batch_id: numeric, tx_hash: txHash, chain_mode: this.chain.mode, explorer_url: this.chain.mode === "live" && base ? `${base}/tx/${txHash}` : null };
      const { dek, wrapped } = this.envelope.newDek();
      const at = iso(this.clock.now());
      this.db
        .prepare(`INSERT INTO zk_commitments (scorecard_id, employee_id, score_bps, commitment, binding, dek_wrapped, salt_enc, anchor_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scorecardId, sc.employee_id, Number(score), commitment.toString(), binding.toString(), wrapped, this.envelope.encrypt(dek, salt.toString()), JSON.stringify(anchor), p.persona_id, at);
      this.audit.append(at, p.persona_id, "zk.committed", scorecardId, { commitment: hex, numeric_batch_id: numeric, tx_hash: txHash });
      return this.toApi(this.row(scorecardId)!);
    });
  }

  /** Only the scorecard's own employee gets the private witness. */
  witness(p: Persona, scorecardId: string): ZkWitness {
    const sc = this.scorecardFor(p, scorecardId);
    if (p.employee_id !== sc.employee_id) throw errors.forbidden("Only the employee can see their own witness");
    const r = this.row(scorecardId);
    if (!r) throw errors.notFound("No ZK commitment for this scorecard yet (HR or the manager creates it)");
    const salt = this.envelope.decrypt(this.envelope.unwrap(r.dek_wrapped), r.salt_enc);
    const a = JSON.parse(r.anchor_json);
    this.audit.append(iso(this.clock.now()), p.persona_id, "zk.witness_read", scorecardId, {});
    return {
      scorecard_id: scorecardId,
      score_bps: r.score_bps,
      salt,
      commitment: r.commitment,
      binding: r.binding,
      numeric_batch_id: a.numeric_batch_id,
      verifier_address: this.config.ZK_VERIFIER_ADDRESS ?? null,
      registry_address: this.config.REGISTRY_ADDRESS,
      chain_id: this.config.CHAIN_ID,
    };
  }
}
