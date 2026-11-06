// Zero-knowledge score proofs (Groth16, circuit packages/zk/circuits/score_threshold.circom).
// The COMPANY commits: commitment = Poseidon(score_bps, salt, binding), binding = keccak256(scorecard_id) >> 8,
// and anchors it on Arc (registry.anchorBatch, batch ids >= 2e9) so the employee cannot choose their own number.
// The EMPLOYEE (only them) fetches the witness and proves "score >= threshold" in their browser; anyone verifies
// the proof locally and against ScoreThresholdVerifier on Arc, and checks the anchored commitment.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { keccakUtf8, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { ApiError, errors } from "../errors.ts";
import { canApprove, canView, isInternal } from "../auth/auth.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { DB } from "../db/index.ts";
import type { OrgRepo, Persona } from "../db/org.ts";
import type { ScorecardRepo } from "../db/scorecards.ts";
import type { ChainClient } from "../chain/types.ts";
import type { Config } from "../config.ts";
import type { Envelope } from "../ledger/envelope.ts";
import { iso, type Clock } from "../util.ts";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, fallback, http, keccak256 as vkeccak, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const SPR_ABI = parseAbi([
  "function record(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[3] pub, uint64 batchId) returns (bytes32)",
  "function isProven(uint256 commitment, uint256 threshold) view returns (bool)",
]);
export type ZkProofRecord = components["schemas"]["ZkProofRecord"];

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

  /**
   * Public relay: record a proof on Arc. The contract verifies the Groth16 proof and the anchored commitment;
   * we only pay the gas (anchor key, under the shared chain lock). Idempotent.
   */
  async recordProof(body: { proof: any; public_signals: string[]; numeric_batch_id: number }): Promise<ZkProofRecord> {
    const addr = this.config.ZK_PROOF_REGISTRY_ADDRESS;
    if (!addr || !this.config.ANCHOR_PRIVATE_KEY || !this.config.RPC_URL) throw errors.invalidState("On-chain proof registry is not configured (ZK_PROOF_REGISTRY_ADDRESS)");
    const sig = body.public_signals.map((x) => BigInt(x));
    if (sig.length !== 3) throw errors.validation("public_signals must have 3 entries");
    const p = body.proof;
    const a = [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])] as const;
    const b = [[BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])], [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])]] as const;
    const c = [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])] as const;
    const pub = [sig[0], sig[1], sig[2]] as const;
    const chain = defineChain({ id: this.config.CHAIN_ID, name: "arc-testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [this.config.RPC_URL] } } });
    // Arc's public RPCs rate-limit (429): use both, with retries and backoff
    const rpcs = [...new Set([this.config.RPC_URL, "https://rpc.testnet.arc.network", "https://rpc.testnet.arc.io"])];
    const transport = fallback(rpcs.map((u) => http(u, { retryCount: 4, retryDelay: 1500, timeout: 30_000 })));
    const pubc = createPublicClient({ chain, transport });
    const key = vkeccak(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [sig[0], sig[1]]));
    const commitment_hex = ("0x" + sig[0].toString(16).padStart(64, "0")) as Hex;
    const base = this.config.EXPLORER_BASE_URL?.replace(/\/$/, "");
    const out = (tx: string | null, already: boolean): ZkProofRecord => ({
      key, contract: addr, chain_id: this.config.CHAIN_ID, tx_hash: tx, explorer_url: tx && base ? `${base}/tx/${tx}` : null,
      already_recorded: already, threshold_bps: Number(sig[1]), commitment_hex,
    });
    const already = await pubc.readContract({ address: addr as Hex, abi: SPR_ABI, functionName: "isProven", args: [sig[0], sig[1]] }).catch(() => {
      throw new ApiError(503, "internal", "Arc RPC is busy (rate limited); try again in a few seconds");
    });
    if (already) return out(null, true);
    return this.exclusive(async () => {
      const account = privateKeyToAccount(this.config.ANCHOR_PRIVATE_KEY as Hex);
      let sim;
      try {
        sim = await pubc.simulateContract({ account, address: addr as Hex, abi: SPR_ABI, functionName: "record", args: [a, b, c, pub, BigInt(body.numeric_batch_id)] });
      } catch (e) {
        throw errors.conflict(`The registry rejected this proof: ${e instanceof Error ? (e as any).shortMessage ?? e.message.split(String.fromCharCode(10))[0] : e}`);
      }
      const tx = await createWalletClient({ chain, account, transport }).writeContract(sim.request);
      await pubc.waitForTransactionReceipt({ hash: tx, timeout: 60_000, pollingInterval: 3_000 }).catch(() => null); // sent; a rate-limited RPC must not hang the request
      this.audit.append(iso(this.clock.now()), "public", "zk.proof_recorded", commitment_hex, { threshold_bps: Number(sig[1]), tx_hash: tx });
      return out(tx, false);
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
