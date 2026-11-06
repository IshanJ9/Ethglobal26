// CR-004 layer 1 inside a peer cluster (department.level). Every member is scored by the SAME deterministic
// engine on the SAME cluster plan; statistics are integers and the board is hashed so a comparison quoted
// in a review can be recomputed. People are never compared across clusters.
import { canonicalJson, keccakUtf8, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { errors } from "../errors.ts";
import { clustersFixture, type ClusterFixture } from "../fixtures.ts";
import { isHr, isInternal } from "../auth/auth.ts";
import { clusterIdOf, type Employee, type OrgRepo, type Persona } from "../db/org.ts";
import type { ComputeResult, ComputeService } from "../scoring/compute.ts";
import type { EvidenceRepo } from "../db/evidence.ts";
import { iso, type Clock } from "../util.ts";
import { distStats, percentileBps, rankDesc, zMilli } from "./stats.ts";

export type Cluster = components["schemas"]["Cluster"];
export type ClusterBoard = components["schemas"]["ClusterBoard"];
type Row = components["schemas"]["ClusterMemberRow"];

export interface KraValue {
  kra_id: string;
  label: string;
  target: number;
  direction: string;
  actual: number;
  attainment_ppm: number;
}

/** Per-KRA values of one result. Commission plans expose quota attainment and payout as their two "KRAs". */
export function kraValues(plan: components["schemas"]["Plan"], r: ComputeResult): KraValue[] {
  if (plan.kind === "tiered_commission") {
    const c = r.commission ?? {};
    return [
      { kra_id: "quota_attainment", label: "Quota attainment (bps)", target: 10000, direction: "higher_better", actual: c.attainment_bps ?? 0, attainment_ppm: (c.attainment_bps ?? 0) * 100 },
      { kra_id: "commission_payout", label: "Commission earned (USD)", target: 0, direction: "higher_better", actual: c.payout ?? 0, attainment_ppm: (c.attainment_bps ?? 0) * 100 },
    ];
  }
  return r.lines.map((l) => {
    const k = plan.kras.find((x) => x.kra_id === l.kra_id)!;
    return { kra_id: l.kra_id, label: k.label, target: l.target, direction: k.direction, actual: l.actual, attainment_ppm: l.attainment_ppm };
  });
}

export interface ClusterComputation {
  cluster: Cluster;
  plan: components["schemas"]["Plan"];
  members: Employee[];
  results: Map<string, ComputeResult>;
  scores: number[];
  evidenceCount: Map<string, number>;
}

export class ClusterService {
  constructor(
    private readonly org: OrgRepo,
    private readonly compute: ComputeService,
    private readonly evidence: EvidenceRepo,
    private readonly clock: Clock,
  ) {}

  private fixtures(): ClusterFixture[] {
    return clustersFixture().clusters;
  }

  list(): Cluster[] {
    const emps = this.org.employees();
    return this.fixtures().map((c) => this.toCluster(c, emps));
  }

  private toCluster(c: ClusterFixture, emps = this.org.employees()): Cluster {
    const plan = this.org.plan(c.plan_id);
    return {
      cluster_id: c.cluster_id,
      label: c.label,
      department: c.department,
      level: c.level,
      plan_id: c.plan_id,
      plan_name: plan?.name ?? c.plan_id,
      member_count: emps.filter((e) => clusterIdOf(e) === c.cluster_id).length,
      ...(c.description ? { description: c.description } : {}),
    };
  }

  get(clusterId: string): Cluster {
    const c = this.fixtures().find((x) => x.cluster_id === clusterId);
    if (!c) throw errors.notFound(`Cluster ${clusterId} not found`);
    return this.toCluster(c);
  }

  members(clusterId: string): Employee[] {
    return this.org.employees().filter((e) => clusterIdOf(e) === clusterId);
  }

  /** Scores every member with the cluster plan (pure engine; identical inputs -> identical numbers). */
  computeAll(clusterId: string, cycleId: string): ClusterComputation {
    const cluster = this.get(clusterId);
    const plan = this.org.plan(cluster.plan_id);
    if (!plan) throw errors.notFound(`Plan ${cluster.plan_id} not found`);
    if (!this.org.cycle(cycleId)) throw errors.notFound(`Cycle ${cycleId} not found`);
    const members = this.members(clusterId);
    const results = new Map<string, ComputeResult>();
    const evidenceCount = new Map<string, number>();
    for (const m of members) {
      results.set(m.employee_id, this.compute.compute({ plan_id: cluster.plan_id, employee_id: m.employee_id, cycle_id: cycleId }));
      evidenceCount.set(m.employee_id, this.evidence.forEmployeeCycle(m.employee_id, cycleId).length);
    }
    return { cluster, plan, members, results, scores: members.map((m) => results.get(m.employee_id)!.score_bps), evidenceCount };
  }

  /** Who may see this cluster, and whose names they may see. */
  private visibility(viewer: Persona, members: Employee[]): (e: Employee) => boolean {
    if (!isInternal(viewer)) throw errors.forbidden("Not available to external co-signers");
    if (isHr(viewer)) return () => true;
    if (viewer.role === "manager") {
      if (!members.some((m) => m.manager_employee_id === viewer.employee_id)) throw errors.notFound("Cluster not found");
      return (e) => e.manager_employee_id === viewer.employee_id || e.employee_id === viewer.employee_id;
    }
    if (!members.some((m) => m.employee_id === viewer.employee_id)) throw errors.notFound("Cluster not found");
    return (e) => e.employee_id === viewer.employee_id;
  }

  board(clusterId: string, cycleId: string, viewer: Persona): ClusterBoard {
    const comp = this.computeAll(clusterId, cycleId);
    const named = this.visibility(viewer, comp.members);
    const { plan, members, results, scores } = comp;
    const kraTable = members.map((m) => kraValues(plan, results.get(m.employee_id)!));
    const kraIds = kraTable[0]?.map((k) => k.kra_id) ?? [];
    const kra_stats = kraIds.map((id, i) => {
      const col = kraTable.map((row) => row[i]);
      return {
        kra_id: id,
        label: col[0].label,
        target: col[0].target,
        direction: col[0].direction,
        actual: distStats(col.map((k) => k.actual)),
        attainment_ppm: distStats(col.map((k) => k.attainment_ppm)),
      };
    });

    const order = members.map((m, i) => ({ m, i })).sort((a, b) => scores[b.i] - scores[a.i] || (a.m.employee_id < b.m.employee_id ? -1 : 1));
    let anon = 0;
    const rows: Row[] = order.map(({ m, i }) => {
      const r = results.get(m.employee_id)!;
      const show = named(m);
      if (!show) anon++;
      return {
        employee_id: show ? m.employee_id : null,
        display_name: show ? m.display_name : `Peer ${anon}`,
        is_self: m.employee_id === viewer.employee_id,
        score_bps: r.score_bps,
        multiplier_bps: r.multiplier_bps,
        bonus_amount: r.bonus_amount,
        gate_passed: r.gate_passed,
        rank: rankDesc(scores, r.score_bps),
        percentile_bps: percentileBps(scores, r.score_bps),
        z_milli: zMilli(scores, r.score_bps),
        kras: kraTable[i].map((k, j) => ({
          kra_id: k.kra_id,
          actual: k.actual,
          attainment_ppm: k.attainment_ppm,
          percentile_bps: percentileBps(kraTable.map((row) => row[j].attainment_ppm), k.attainment_ppm),
        })),
        evidence_count: comp.evidenceCount.get(m.employee_id) ?? 0,
      };
    });

    return {
      cluster: comp.cluster,
      cycle_id: cycleId,
      plan_id: plan.plan_id,
      formula_hash: plan.formula_hash,
      score_stats: distStats(scores),
      kra_stats,
      rows,
      board_hash: boardHash(comp, cycleId),
      generated_at: iso(this.clock.now()),
    };
  }
}

/** Hash of exactly what the comparison was computed from (member, score, inputs_hash), sorted by employee. */
export function boardHash(comp: ClusterComputation, cycleId: string): Hex {
  const rows = comp.members
    .map((m) => ({ employee_id: m.employee_id, score_bps: comp.results.get(m.employee_id)!.score_bps, inputs_hash: comp.results.get(m.employee_id)!.inputs_hash }))
    .sort((a, b) => (a.employee_id < b.employee_id ? -1 : 1));
  return keccakUtf8(canonicalJson({ schema: "pw.cluster_board.v1", cluster_id: comp.cluster.cluster_id, cycle_id: cycleId, formula_hash: comp.plan.formula_hash, rows }));
}
