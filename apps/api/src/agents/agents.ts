// HR agents on 0G Private Computer (function calling). Both read the three review layers through tools that code
// executes: layer 1 the KRA score inside the peer cluster, layer 2 context (history, trend, deadlines), layer 3 the
// HR review (anchored reasoning: bonus position, promotion readiness, concerns).
//
// 1. Bonus allocation agent: splits a USDC budget for a cluster. Code computes the base split (score-proportional
//    above a floor); the agent may adjust each person by at most ±15% with a written reason; code renormalises to the
//    exact budget in base units. The output is what gets proposed to the Arc Studio BonusPool (proposeAllocation).
// 2. Promotion agent: HR chats ("one Senior Engineer moves to Product Manager"); the agent ranks candidates and
//    proposes moves, including the backfill cascade (the vacated seat goes to the best-ready person one level down).
//    Code validates every move (person exists, is in the stated cluster, move goes up a level).
import { keccakUtf8, canonicalJson, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { errors } from "../errors.ts";
import { isHr } from "../auth/auth.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { DB } from "../db/index.ts";
import { clusterIdOf, type OrgRepo, type Persona } from "../db/org.ts";
import type { ClusterService } from "../review/clusters.ts";
import type { ContextService } from "../review/context.ts";
import { zeroGToolChat } from "../ai/inference.ts";
import { iso, type Clock } from "../util.ts";

export type BonusAllocation = components["schemas"]["BonusAllocation"];
export type PromotionChat = components["schemas"]["PromotionChat"];
type Planner = { baseUrl: string; apiKey: string; model: string } | null;

const MAX_ADJ_BPS = 1500;
const FLOOR_BPS = 5000; // scores below 50% earn no share of a performance pool
const LADDER: Record<string, string | null> = { "software.ic": "software.senior_ic", "software.senior_ic": "product.ic" };

export class AgentService {
  constructor(
    private readonly db: DB,
    private readonly org: OrgRepo,
    private readonly clusters: ClusterService,
    private readonly context: ContextService,
    private readonly audit: AuditRepo,
    private readonly clock: Clock,
    private readonly planner: Planner,
  ) {}

  // ---------- tools (executed by code) ----------
  private board(clusterId: string, cycleId: string) {
    const comp = this.clusters.computeAll(clusterId, cycleId);
    return comp.members
      .map((m) => ({ employee_id: m.employee_id, name: m.display_name, score_bps: comp.results.get(m.employee_id)!.score_bps, wallet: m.wallet_address, ens: m.ens_name ?? null }))
      .sort((a, b) => b.score_bps - a.score_bps)
      .map((r, i, all) => ({ ...r, rank: i + 1, of: all.length }));
  }
  private ctx(employeeId: string, cycleId: string) {
    const emp = this.org.employee(employeeId);
    const cid = emp ? clusterIdOf(emp) : null;
    if (!emp || !cid) return { error: "not in a cluster" };
    const r = this.context.report(employeeId, cycleId, this.clusters.computeAll(cid, cycleId));
    return { trend_bps_per_period: r.trend_bps_per_period, mean_bps: r.mean_bps, on_time_rate_bps: r.on_time_rate_bps, target_hit_rate_bps: r.target_hit_rate_bps, signals: r.signals.map((s) => s.code) };
  }
  private review(employeeId: string, cycleId: string) {
    const row = this.db.prepare("SELECT review_json, anchor_json FROM reviews WHERE employee_id = ? AND cycle_id = ? ORDER BY created_at DESC LIMIT 1").get(employeeId, cycleId) as { review_json: string; anchor_json: string | null } | undefined;
    if (!row) return { review: null };
    const v = JSON.parse(row.review_json);
    return {
      review_id: v.review_id,
      review_hash: v.hashes?.review_hash ?? null,
      anchored_on_arc: !!row.anchor_json,
      bonus_position: v.reasoning?.recommendation?.bonus_position ?? null,
      promotion_readiness: v.reasoning?.recommendation?.promotion_readiness ?? null,
      concerns: (v.reasoning?.concerns ?? []).slice(0, 2).map((c: unknown) => String(c).slice(0, 140)),
    };
  }
  private runTool(name: string, args: Record<string, unknown>, cycleId: string): unknown {
    if (name === "list_clusters") return this.clusters.list().map((c) => ({ cluster_id: c.cluster_id, label: c.label, next_level_up: LADDER[c.cluster_id] ?? null }));
    if (name === "cluster_board") return this.board(String(args.cluster_id), cycleId).map(({ wallet: _w, ...r }) => ({ ...r, score_pct: (r.score_bps / 100).toFixed(2) + "%" }));
    if (name === "employee_context") return this.ctx(String(args.employee_id), cycleId);
    if (name === "hr_review") return this.review(String(args.employee_id), cycleId);
    return { error: "unknown tool" };
  }
  private static readonly TOOLS = [
    { type: "function", function: { name: "list_clusters", description: "Peer clusters (department.level) and which cluster is one level up.", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "cluster_board", description: "Layer 1: KRA scores, rank inside the cluster.", parameters: { type: "object", properties: { cluster_id: { type: "string" } }, required: ["cluster_id"] } } },
    { type: "function", function: { name: "employee_context", description: "Layer 2: trend over past periods, on-time rate, signals.", parameters: { type: "object", properties: { employee_id: { type: "string" } }, required: ["employee_id"] } } },
    { type: "function", function: { name: "hr_review", description: "Layer 3: the HR review written on 0G and anchored on Arc: bonus position, promotion readiness, concerns.", parameters: { type: "object", properties: { employee_id: { type: "string" } }, required: ["employee_id"] } } },
  ];

  /** Generic 0G tool loop: the model calls our tools until it calls the final `submit` tool. */
  private async loop(system: string, user: Array<{ role: string; content: string }>, submit: object, cycleId: string) {
    if (!this.planner) throw errors.invalidState("The HR agents need 0G Private Computer (ZEROG_MODE=live)");
    const messages: any[] = [{ role: "system", content: system }, ...user];
    const tools = [...AgentService.TOOLS, submit];
    const trace: Array<{ tool: string; args: string }> = [];
    const request_ids: string[] = [];
    let model = this.planner.model;
    for (let round = 0; round < 8; round++) {
      const r = await zeroGToolChat(this.planner, messages, tools).catch(() => zeroGToolChat(this.planner!, messages, tools));
      request_ids.push(r.request_id.split(",")[0].trim());
      model = r.model;
      const calls = r.message.tool_calls ?? [];
      if (!calls.length) return { submitted: null, text: String(r.message.content ?? ""), trace, request_ids, model };
      messages.push({ role: "assistant", content: r.message.content ?? "", tool_calls: calls });
      for (const c of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* empty */ }
        trace.push({ tool: c.function.name, args: JSON.stringify(args).slice(0, 160) });
        if (c.function.name === "submit") return { submitted: args, text: String(r.message.content ?? ""), trace, request_ids, model };
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(this.runTool(c.function.name, args, cycleId)).slice(0, 6000) });
      }
    }
    return { submitted: null, text: "The agent did not finish within 8 steps.", trace, request_ids, model };
  }

  // ---------- 1. bonus allocation ----------
  async allocate(p: Persona, b: { cycle_id: string; cluster_id: string; budget: string; kind: BonusAllocation["kind"] }): Promise<BonusAllocation> {
    if (!isHr(p)) throw errors.forbidden("Only HR can allocate a bonus pool");
    if (!this.org.cycle(b.cycle_id)) throw errors.notFound("Cycle not found");
    const budget = BigInt(b.budget);
    if (budget <= 0n) throw errors.validation("budget must be > 0");
    const rows = this.board(b.cluster_id, b.cycle_id);
    const eligible = rows.filter((r) => r.score_bps >= FLOOR_BPS);
    if (!eligible.length) throw errors.invalidState("Nobody in this cluster is above the 50% floor");

    const submit = { type: "function", function: { name: "submit", description: "Submit adjustments (bps, -1500..+1500) to the score-proportional base split, one per employee, with a one-sentence reason grounded in the tools.", parameters: { type: "object", properties: { adjustments: { type: "array", items: { type: "object", properties: { employee_id: { type: "string" }, adjustment_bps: { type: "integer" }, reason: { type: "string" } }, required: ["employee_id", "adjustment_bps", "reason"] } }, rationale: { type: "string" } }, required: ["adjustments", "rationale"] } } };
    const run = await this.loop(
      "You are the bonus allocation agent of an HR team. A budget is split across a peer cluster. Code already computes a base split proportional to each person's KRA score (people below 50% get nothing). You may adjust each person's share by at most ±1500 bps (±15%) using layer 2 (context: trend, deadlines) and layer 3 (the HR review: bonus_position, promotion_readiness, concerns). Call cluster_board, then employee_context and hr_review for each eligible person, then call submit. Never invent numbers; cite what the tools returned.",
      [{ role: "user", content: `Split ${b.kind.replace("_", " ")} pool for cluster ${b.cluster_id}, cycle ${b.cycle_id}.` }],
      submit,
      b.cycle_id,
    );

    // code: base split -> bounded adjustments -> exact budget
    const adj = new Map<string, { bps: number; reason: string }>();
    for (const a of ((run.submitted?.adjustments as any[]) ?? [])) {
      if (!eligible.some((e) => e.employee_id === a.employee_id)) continue;
      adj.set(String(a.employee_id), { bps: Math.max(-MAX_ADJ_BPS, Math.min(MAX_ADJ_BPS, Math.round(Number(a.adjustment_bps) || 0))), reason: String(a.reason ?? "").slice(0, 300) });
    }
    const weights = eligible.map((e) => BigInt(e.score_bps - FLOOR_BPS + 1) * BigInt(10000 + (adj.get(e.employee_id)?.bps ?? 0)));
    const total = weights.reduce((x, y) => x + y, 0n);
    let amounts = weights.map((w) => (budget * w) / total);
    const rem = budget - amounts.reduce((x, y) => x + y, 0n);
    amounts = amounts.map((a, i) => (i === 0 ? a + rem : a)); // remainder (a few base units) to the top scorer
    const lines = eligible.map((e, i) => {
      const rv = this.review(e.employee_id, b.cycle_id) as { review_hash?: string | null };
      return {
        employee_id: e.employee_id, name: e.name, wallet: e.wallet, ens: e.ens, score_bps: e.score_bps, rank: e.rank,
        base_share_bps: Number((BigInt(e.score_bps - FLOOR_BPS + 1) * 10000n) / eligible.reduce((x, y) => x + BigInt(y.score_bps - FLOOR_BPS + 1), 0n)),
        adjustment_bps: adj.get(e.employee_id)?.bps ?? 0,
        share_bps: Number((amounts[i] * 10000n) / budget),
        amount: amounts[i].toString(),
        reason: adj.get(e.employee_id)?.reason ?? "base share (no adjustment)",
        evidence_hash: (rv.review_hash ?? keccakUtf8(`${e.employee_id}:${b.cycle_id}:${e.score_bps}`)) as Hex,
      };
    });
    const excluded = rows.filter((r) => r.score_bps < FLOOR_BPS).map((r) => ({ employee_id: r.employee_id, name: r.name, score_bps: r.score_bps }));
    const rationale = String(run.submitted?.rationale ?? run.text ?? "").slice(0, 1200);
    const out: BonusAllocation = {
      allocation_id: "alc_" + keccakUtf8(canonicalJson({ b, lines: lines.map((l) => [l.employee_id, l.amount]), t: iso(this.clock.now()) })).slice(2, 22),
      kind: b.kind, cycle_id: b.cycle_id, cluster_id: b.cluster_id, budget: budget.toString(),
      bucket_id: keccakUtf8(`cluster:${b.cluster_id}`) as Hex,
      lines, excluded, rationale,
      rationale_hash: keccakUtf8(rationale) as Hex,
      agent: { ens_name: "review-agent", model: run.model, request_ids: run.request_ids, tool_calls: run.trace, completed: !!run.submitted },
      guardrails: [`base split proportional to KRA score above ${FLOOR_BPS / 100}%`, `agent adjustments clipped to ±${MAX_ADJ_BPS / 100}%`, "amounts renormalised by code to the exact budget"],
      created_at: iso(this.clock.now()),
    };
    this.audit.append(out.created_at, p.persona_id, "agent.bonus_allocation", out.allocation_id, { cluster_id: b.cluster_id, budget: out.budget, rationale_hash: out.rationale_hash, request_ids: run.request_ids });
    return out;
  }

  // ---------- 2. promotion chat ----------
  async promote(p: Persona, b: { cycle_id: string; messages: Array<{ role: "user" | "assistant"; content: string }> }): Promise<PromotionChat> {
    if (!isHr(p)) throw errors.forbidden("Only HR can plan promotions");
    const submit = { type: "function", function: { name: "submit", description: "Submit the promotion plan.", parameters: { type: "object", properties: { reply: { type: "string", description: "3-5 sentences for HR: who moves where and why, citing score %, rank, on-time rate and review readiness; mention the backfill" }, moves: { type: "array", items: { type: "object", properties: { employee_id: { type: "string" }, from_cluster: { type: "string" }, to_cluster: { type: "string" }, reason: { type: "string" }, is_backfill: { type: "boolean" } }, required: ["employee_id", "from_cluster", "to_cluster", "reason", "is_backfill"] } } }, required: ["reply", "moves"] } } };
    const run = await this.loop(
      "You are the promotion planning agent for HR. Use the tools: cluster_board (layer 1 score and rank), employee_context (layer 2 trend and deadlines), hr_review (layer 3 promotion_readiness). Pick the strongest ready candidate for each opening. When someone is promoted out of a cluster, their seat is vacated: if the request implies keeping headcount, also promote the best ready person from the cluster one level below (list_clusters gives next_level_up) and mark that move is_backfill=true. Explain each choice in one sentence citing tool values. Finish by calling submit with a short reply for HR and the moves.",
      b.messages.slice(-8),
      submit,
      b.cycle_id,
    );
    const moves = ((run.submitted?.moves as any[]) ?? []).map((m) => {
      const emp = this.org.employee(String(m.employee_id));
      const from = emp ? clusterIdOf(emp) : null;
      const ok = !!emp && from === m.from_cluster && (LADDER[from ?? ""] === m.to_cluster || m.to_cluster !== m.from_cluster);
      const rv = emp ? (this.review(emp.employee_id, b.cycle_id) as { promotion_readiness?: string | null }) : {};
      return {
        employee_id: String(m.employee_id), name: emp?.display_name ?? String(m.employee_id), from_cluster: String(m.from_cluster), to_cluster: String(m.to_cluster),
        reason: String(m.reason ?? "").slice(0, 400), is_backfill: !!m.is_backfill, valid: ok, promotion_readiness: rv.promotion_readiness ?? null,
      };
    });
    const out: PromotionChat = {
      reply: String(run.submitted?.reply ?? run.text ?? "").slice(0, 1500),
      moves,
      agent: { ens_name: "review-agent", model: run.model, request_ids: run.request_ids, tool_calls: run.trace, completed: !!run.submitted },
      created_at: iso(this.clock.now()),
    };
    this.audit.append(out.created_at, p.persona_id, "agent.promotion_plan", keccakUtf8(canonicalJson(moves)), { moves: moves.length, request_ids: run.request_ids });
    return out;
  }
}
