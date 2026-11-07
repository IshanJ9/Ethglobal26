import { objectAction } from "../world/verifier.ts";
import type { EnsCredentials } from "../ens/credentials.ts";
import type { AgentPassService } from "../agentpass/agentpass.ts";
// CR-004: a three-layer review (layer 1 KRA score in the cluster, layer 2 context, layer 3 0G reasoning),
// stored with every hash needed to prove what it was built from, and anchorable on chain.
import { canonicalJson, keccakUtf8, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { ApiError, errors } from "../errors.ts";
import { canView, isHr, isInternal } from "../auth/auth.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { EvidenceRepo } from "../db/evidence.ts";
import { clusterIdOf, type Employee, type OrgRepo, type Persona } from "../db/org.ts";
import type { DB } from "../db/index.ts";
import type { ChainClient } from "../chain/types.ts";
import type { Config } from "../config.ts";
import { loadContract } from "../contract/openapi.ts";
import { iso, newId, type Clock } from "../util.ts";
import { kraValues, type ClusterService } from "./clusters.ts";
import { HISTORY_KIND, type ContextService } from "./context.ts";
import { allowedNumbers, buildPacket, checkNumbers, parseReasoning, reasoningHash, SYSTEM_PROMPT, templateReasoning, type Reasoner, type Reasoning } from "./reasoning.ts";
import { percentileBps, rankDesc, zMilli, distStats } from "./stats.ts";
import type { VaultReader } from "./vault.ts";
import { consumeNullifier, worldResultHash, type WorldResult, type WorldVerifier } from "../world/verifier.ts";

export type Review = components["schemas"]["Review"];
export type ReviewSummary = components["schemas"]["ReviewSummary"];

const REVIEW_BATCH_BASE = 1_000_000_000; // review anchors never collide with evidence batch ids
/** World ID actions (create both in the World Developer Portal). Signal = the review hash. */
export const ANCHOR_WORLD_ACTION = "pw-anchor-review";
export const ACK_WORLD_ACTION = "pw-ack-review";

export class ReviewService {
  constructor(
    private readonly db: DB,
    private readonly org: OrgRepo,
    private readonly evidence: EvidenceRepo,
    private readonly clusters: ClusterService,
    private readonly context: ContextService,
    private readonly vault: VaultReader,
    private readonly reasoner: Reasoner | null,
    private readonly chain: ChainClient,
    private readonly world: WorldVerifier,
    private readonly audit: AuditRepo,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly log: (m: string, d?: Record<string, unknown>) => void = () => {},
    /** Shared chain-write lock (ChainService.exclusive): one sender, no batch-id or nonce races. */
    private readonly exclusive: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
    /** ENS review credentials (expiring, non-transferable subname per anchored review). Optional. */
    private readonly credentials: EnsCredentials | null = null,
    /** World ID Agent Pass: human checkpoint before the review agent reads the vault. Optional. */
    private readonly agentPass: AgentPassService | null = null,
  ) {}

  private canCreate(viewer: Persona, e: Employee) {
    return isHr(viewer) || (viewer.role === "manager" && e.manager_employee_id === viewer.employee_id);
  }

  async create(viewer: Persona, employeeId: string, cycleId: string, peerId: string | null | undefined, agentPassCheckpointId?: string | null): Promise<Review> {
    const emp = this.org.employee(employeeId);
    if (!emp || !canView(viewer, emp)) throw errors.notFound("Employee not found");
    if (!this.canCreate(viewer, emp)) throw errors.forbidden("Only HR or the employee's manager can prepare a review");
    const cycle = this.org.cycle(cycleId);
    if (!cycle) throw errors.notFound("Cycle not found");
    const clusterId = clusterIdOf(emp);
    if (!clusterId) throw new ApiError(409, "cluster_mismatch", `${emp.display_name} is not in a peer cluster`);
    let peer: Employee | null = null;
    if (peerId) {
      peer = this.org.employee(peerId) ?? null;
      if (!peer || !canView(viewer, peer)) throw errors.notFound("Peer not found");
      if (peer.employee_id === emp.employee_id) throw errors.validation("Pick a different peer");
      if (clusterIdOf(peer) !== clusterId) {
        throw new ApiError(409, "cluster_mismatch", `${peer.display_name} is in ${clusterIdOf(peer) ?? "no cluster"}, not ${clusterId}; people are only compared inside their own cluster`, {
          employee_cluster: clusterId,
          peer_cluster: clusterIdOf(peer),
        });
      }
    }

    // Layer 1 (whole cluster, same plan) and layer 2.
    const comp = this.clusters.computeAll(clusterId, cycleId);
    const result = comp.results.get(employeeId)!;
    const scores = comp.scores;
    const ctx = this.context.report(employeeId, cycleId, comp);
    const { _notes, ...contextReport } = ctx;

    // Vault: every evidence item of the subject (and peer) is read back and its commitment recomputed.
    // World ID Agent Pass: a fresh, Orb-verified human approval for exactly this operation, used once, before the agent reads any vault data.
    const agentPass = this.agentPass?.consume(viewer, agentPassCheckpointId, { kind: "review.generate", employee_id: employeeId, cycle_id: cycleId, peer_employee_id: peer?.employee_id ?? null }) ?? null;
    const rows = [employeeId, ...(peer ? [peer.employee_id] : [])].flatMap((id) => this.evidence.forEmployeeCycle(id, cycleId));
    const { report: vault, payloads } = await this.vault.read(rows);

    const kras = kraValues(comp.plan, result);
    const packet = buildPacket({
      name: emp.display_name,
      comp,
      result,
      kras,
      rank: rankDesc(scores, result.score_bps),
      percentile_bps: percentileBps(scores, result.score_bps),
      z_milli: zMilli(scores, result.score_bps),
      context: contextReport,
      notes: _notes,
      peer: peer ? { name: peer.display_name, result: comp.results.get(peer.employee_id)!, kras: kraValues(comp.plan, comp.results.get(peer.employee_id)!) } : null,
      evidence: rows.filter((r) => r.employee_id === employeeId),
      payloads,
      cycleLabel: cycle.label,
    });
    const packetJson = canonicalJson(packet);
    const packet_hash = keccakUtf8(packetJson);
    const allowed = allowedNumbers(packet);

    // KRA -> evidence ids, history ids (citations for the deterministic writer)
    const kraEvidence = new Map<string, string[]>();
    for (const l of result.lines) {
      const k = comp.plan.kras.find((x) => x.kra_id === l.kra_id);
      if (k) kraEvidence.set(k.label, l.evidence_ids?.length ? l.evidence_ids : ["layer1.kras"]);
    }
    const historyIds = rows.filter((r) => r.employee_id === employeeId && r.kind === HISTORY_KIND).map((r) => r.evidence_id);
    const pctl = percentileBps(scores, result.score_bps);

    // Layer 3: 0G Private Computer, number-checked; deterministic writer as mock / fallback.
    let reasoning: Reasoning;
    let source: Review["reasoning_source"];
    let inference: Review["inference"] = null;
    let provider: string | null = null;
    let fallback_reason: string | null = null;
    let number_check: Review["number_check"];
    if (this.reasoner) {
      const validate = loadContract().schema("Reasoning");
      const user = `PACKET:\n${packetJson}`;
      let attempt = 0;
      let lastErr = "";
      let got: Reasoning | null = null;
      let check: Review["number_check"] | null = null;
      while (attempt < 2 && !got) {
        attempt++;
        try {
          const prompt = attempt === 1 ? user : `${user}\n\nYOUR PREVIOUS ANSWER WAS REJECTED: ${lastErr}. Answer again following every rule; copy numbers exactly from the packet.`;
          const out = await this.reasoner.complete(SYSTEM_PROMPT, prompt);
          inference = out.record;
          provider = out.provider;
          const parsed = parseReasoning(out.output, validate);
          if (!parsed.ok) {
            lastErr = parsed.error;
            continue;
          }
          check = checkNumbers(parsed.value, allowed, attempt, packet);
          if (!check.passed) {
            lastErr = `these numbers or claims are not supported by the packet: ${check.unsupported.slice(0, 12).join(", ")}`;
            continue;
          }
          got = parsed.value;
        } catch (e) {
          lastErr = `0G call failed: ${(e as Error).message.slice(0, 160)}`;
          this.log("0G reasoning call failed", { error: lastErr });
        }
      }
      if (got && check) {
        reasoning = got;
        source = "0g_private_computer";
        number_check = check;
      } else {
        reasoning = templateReasoning(packet, pctl, kraEvidence, historyIds);
        source = "deterministic_fallback";
        fallback_reason = lastErr || "0G reasoning unavailable";
        number_check = { ...checkNumbers(reasoning, allowed, attempt, packet), attempts: attempt };
      }
    } else {
      reasoning = templateReasoning(packet, pctl, kraEvidence, historyIds);
      source = "mock";
      number_check = checkNumbers(reasoning, allowed, 0, packet);
    }

    const output_hash = reasoningHash(reasoning);
    const hashes = {
      packet_hash,
      context_hash: contextReport.context_hash,
      inputs_hash: result.inputs_hash,
      output_hash,
      review_hash: keccakUtf8(canonicalJson({ schema: "pw.review.v1", packet_hash, context_hash: contextReport.context_hash, inputs_hash: result.inputs_hash, output_hash })) as Hex,
    };
    const peerCmp = peer
      ? {
          peer_employee_id: peer.employee_id,
          peer_display_name: peer.display_name,
          score_bps_self: result.score_bps,
          score_bps_peer: comp.results.get(peer.employee_id)!.score_bps,
          kras: kras.map((k) => {
            const p = kraValues(comp.plan, comp.results.get(peer!.employee_id)!).find((x) => x.kra_id === k.kra_id)!;
            const col = comp.members.map((m) => kraValues(comp.plan, comp.results.get(m.employee_id)!).find((x) => x.kra_id === k.kra_id)!.actual);
            return { kra_id: k.kra_id, label: k.label, self: k.actual, peer: p.actual, ratio_milli: p.actual === 0 ? null : Math.round((k.actual / p.actual) * 1000), cluster_median: distStats(col).median };
          }),
        }
      : null;

    const reviewId = newId("rev");
    const review: Review = {
      review_id: reviewId,
      employee_id: employeeId,
      display_name: emp.display_name,
      cycle_id: cycleId,
      cluster: comp.cluster,
      layer1: { result, rank: rankDesc(scores, result.score_bps), n: scores.length, percentile_bps: pctl, z_milli: zMilli(scores, result.score_bps), score_stats: distStats(scores) },
      context: contextReport,
      peer: peerCmp,
      vault,
      reasoning,
      reasoning_source: source,
      inference,
      inference_provider: provider,
      fallback_reason,
      number_check,
      hashes,
      anchor: null,
      acknowledgement: null,
      agent_pass: agentPass,
      world_actions: { anchor: objectAction(ANCHOR_WORLD_ACTION, reviewId), acknowledge: objectAction(ACK_WORLD_ACTION, reviewId), signal: hashes.review_hash },
      reasoning_agent: {
        ens_name: this.config.ENS_PARENT_NAME ? `review-agent.${this.config.ENS_PARENT_NAME}` : null,
        system_prompt_hash: keccakUtf8(SYSTEM_PROMPT),
        model: inference?.model ?? (source === "mock" ? "deterministic-writer" : "deterministic-fallback"),
      },
      created_by: viewer.persona_id,
      created_at: iso(this.clock.now()),
    };
    this.db
      .prepare(
        `INSERT INTO reviews (review_id, employee_id, cycle_id, cluster_id, peer_employee_id, review_json, review_hash, reasoning_source, anchor_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(review.review_id, employeeId, cycleId, clusterId, peer?.employee_id ?? null, JSON.stringify(review), hashes.review_hash, source, viewer.persona_id, review.created_at);
    this.audit.append(review.created_at, viewer.persona_id, "review.created", review.review_id, {
      employee_id: employeeId,
      cluster_id: clusterId,
      peer_employee_id: peer?.employee_id ?? null,
      reasoning_source: source,
      review_hash: hashes.review_hash,
      vault_items: vault.items_total,
      commitments_matched: vault.commitments_matched,
    });
    return review;
  }

  private row(id: string): { review_json: string; anchor_json: string | null; ack_json: string | null; employee_id: string } | undefined {
    return this.db.prepare("SELECT review_json, anchor_json, ack_json, employee_id FROM reviews WHERE review_id = ?").get(id) as any;
  }

  private hydrate(r: { review_json: string; anchor_json: string | null; ack_json?: string | null }): Review {
    const v = JSON.parse(r.review_json) as Review;
    return {
      ...v,
      anchor: r.anchor_json ? JSON.parse(r.anchor_json) : null,
      acknowledgement: r.ack_json ? JSON.parse(r.ack_json) : null,
      world_actions: v.world_actions ?? { anchor: ANCHOR_WORLD_ACTION, acknowledge: ACK_WORLD_ACTION, signal: v.hashes.review_hash },
      reasoning_agent: v.reasoning_agent ?? {
        ens_name: this.config.ENS_PARENT_NAME ? `review-agent.${this.config.ENS_PARENT_NAME}` : null,
        system_prompt_hash: keccakUtf8(SYSTEM_PROMPT),
        model: v.inference?.model ?? "deterministic-writer",
      },
    };
  }

  /** World ID check bound to (action, review hash); the nullifier is consumed so a proof works once. */
  private async worldCheck(viewer: Persona, action: string, review: Review, result: WorldResult | undefined, at: string): Promise<{ nullifier: string; wrh: string }> {
    const chk = await this.world.verify({ action, signal: review.hashes.review_hash, result });
    if (!chk.ok) {
      this.audit.append(at, viewer.persona_id, "review.world_failed", review.review_id, { action, reason: chk.reason });
      throw new ApiError(401, "world_verification_failed", `World verification failed: ${chk.reason}`);
    }
    return { nullifier: chk.nullifier, wrh: worldResultHash(result!) };
  }

  /** The reviewed employee confirms, with World ID, that they received exactly this review (once). */
  async acknowledge(viewer: Persona, id: string, worldResult: WorldResult | undefined): Promise<Review> {
    const r = this.row(id);
    if (!r || !isInternal(viewer) || !canView(viewer, this.org.employee(r.employee_id))) throw errors.notFound("Review not found");
    if (viewer.employee_id !== r.employee_id) throw errors.forbidden("Only the reviewed employee can acknowledge their review");
    const review = this.hydrate(r);
    if (review.acknowledgement) throw errors.invalidState("Review already acknowledged");
    const at = iso(this.clock.now());
    const ackAction = review.world_actions?.acknowledge ?? ACK_WORLD_ACTION;
    const { nullifier, wrh } = await this.worldCheck(viewer, ackAction, review, worldResult, at);
    const ack = { acknowledged_by: viewer.employee_id, acknowledged_at: at, world_result_hash: wrh, world_mode: this.world.mode };
    this.db.transaction(() => {
      if (!consumeNullifier(this.db, nullifier, `${ackAction}:${id}`, at)) throw new ApiError(401, "world_verification_failed", "World proof was already used (replay)");
      // Conditional write: a concurrent second acknowledgement loses here and rolls back (its World proof stays unused).
      const res = this.db.prepare("UPDATE reviews SET ack_json = ? WHERE review_id = ? AND ack_json IS NULL").run(JSON.stringify(ack), id);
      if (res.changes === 0) throw errors.invalidState("Review already acknowledged");
      this.audit.append(at, viewer.persona_id, "review.acknowledged", id, { review_hash: review.hashes.review_hash, world_result_hash: wrh });
    })();
    return { ...review, acknowledgement: ack };
  }

  get(viewer: Persona, id: string): Review {
    const r = this.row(id);
    if (!r || !isInternal(viewer) || !canView(viewer, this.org.employee(r.employee_id))) throw errors.notFound("Review not found");
    return this.hydrate(r);
  }

  list(viewer: Persona, f: { employeeId?: string; cycleId?: string }): ReviewSummary[] {
    if (!isInternal(viewer)) throw errors.forbidden("Not available to external co-signers");
    const rows = this.db
      .prepare(`SELECT review_json, anchor_json, ack_json, employee_id FROM reviews WHERE (? IS NULL OR employee_id = ?) AND (? IS NULL OR cycle_id = ?) ORDER BY created_at DESC LIMIT 200`)
      .all(f.employeeId ?? null, f.employeeId ?? null, f.cycleId ?? null, f.cycleId ?? null) as Array<{ review_json: string; anchor_json: string | null; ack_json: string | null; employee_id: string }>;
    return rows
      .filter((r) => canView(viewer, this.org.employee(r.employee_id)))
      .map((r) => {
        const v = this.hydrate(r);
        return {
          review_id: v.review_id,
          employee_id: v.employee_id,
          display_name: v.display_name,
          cycle_id: v.cycle_id,
          cluster_id: v.cluster.cluster_id,
          peer_employee_id: v.peer?.peer_employee_id ?? null,
          headline: v.reasoning.headline,
          score_bps: v.layer1.result.score_bps,
          reasoning_source: v.reasoning_source,
          review_hash: v.hashes.review_hash,
          anchor_tx_hash: v.anchor?.tx_hash ?? null,
          acknowledged: !!v.acknowledgement,
          created_at: v.created_at,
        };
      });
  }

  /** HR anchors the review hash with anchorBatch(review_hash, id >= 1e9, 1). Idempotent. */
  async anchor(viewer: Persona, id: string, worldResult?: WorldResult): Promise<Review> {
    if (!isHr(viewer)) throw errors.forbidden("Only HR can anchor a review");
    // Under the chain lock, and re-read inside it, so a double click cannot anchor twice.
    return this.exclusive(() => this.anchorNow(viewer, id, worldResult));
  }

  private async anchorNow(viewer: Persona, id: string, worldResult?: WorldResult): Promise<Review> {
    const r = this.row(id);
    if (!r) throw errors.notFound("Review not found");
    const review = this.hydrate(r);
    if (review.anchor) return review;
    // World ID step-up: a real, unique human signs off before the review hash goes on chain.
    const stepAt = iso(this.clock.now());
    const anchorAction = review.world_actions?.anchor ?? ANCHOR_WORLD_ACTION;
    const { nullifier, wrh } = await this.worldCheck(viewer, anchorAction, review, worldResult, stepAt);
    if (!consumeNullifier(this.db, nullifier, `${anchorAction}:${id}`, stepAt)) {
      throw new ApiError(401, "world_verification_failed", "World proof was already used (replay)");
    }
    const used = (this.db.prepare("SELECT COUNT(*) FROM reviews WHERE anchor_json IS NOT NULL").pluck().get() as number) ?? 0;
    let numeric = REVIEW_BATCH_BASE + used + 1;
    const zero = "0x" + "00".repeat(32);
    while ((await this.chain.batchRoot(BigInt(numeric))) !== zero) numeric++;
    const { txHash } = await this.chain.anchorBatch(review.hashes.review_hash as Hex, BigInt(numeric), 1);
    const base = this.config.EXPLORER_BASE_URL?.replace(/\/$/, "");
    const anchor = {
      numeric_batch_id: numeric,
      tx_hash: txHash,
      chain_mode: this.chain.mode,
      explorer_url: this.chain.mode === "live" && base ? `${base}/tx/${txHash}` : null,
      anchored_at: iso(this.clock.now()),
      anchored_by: viewer.persona_id,
      world_result_hash: wrh,
    };
    this.db.prepare("UPDATE reviews SET anchor_json = ? WHERE review_id = ?").run(JSON.stringify(anchor), id);
    this.audit.append(anchor.anchored_at, viewer.persona_id, "review.anchored", id, { review_hash: review.hashes.review_hash, numeric_batch_id: numeric, tx_hash: txHash, chain_mode: this.chain.mode });
    this.issueCredential(viewer, review, txHash);
    return { ...review, anchor };
  }

  /** Background: register r-<hash8>.<parent> to the employee (ENS). Never blocks or fails the anchor. */
  private issueCredential(viewer: Persona, review: Review, txHash: string) {
    if (!this.credentials?.enabled || this.chain.mode !== "live") return;
    const emp = this.org.employee(review.employee_id);
    if (!emp) return;
    this.credentials
      .issue({ reviewHash: review.hashes.review_hash as Hex, anchorTx: txHash, chainId: this.config.CHAIN_ID, owner: emp.wallet_address as Hex, employeeEns: emp.ens_name ?? null, cluster: review.cluster.cluster_id })
      .then((r) => r && this.audit.append(iso(this.clock.now()), viewer.persona_id, "review.credential_issued", review.review_id, r))
      .catch((e) => this.log(`ENS review credential failed for ${review.review_id}: ${e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : e}`));
  }
}
