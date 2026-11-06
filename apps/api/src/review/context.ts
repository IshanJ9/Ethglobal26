// CR-004 layer 2: context. How the person did before (HRIS performance reviews per past period), how they
// keep dates (ticket-system deadline record), target hit rate, trend, volatility and their position in the
// cluster. Pure code over committed evidence: no model is involved, and the report is hashed.
import { canonicalJson, keccakUtf8 } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { errors } from "../errors.ts";
import type { EvidenceRepo, EvidenceRow } from "../db/evidence.ts";
import { clusterIdOf, type OrgRepo } from "../db/org.ts";
import { COUNTED } from "../engine/engine.ts";
import type { Envelope } from "../ledger/envelope.ts";
import { kraValues, type ClusterComputation } from "./clusters.ts";
import { days10, distStats, pct, percentileBps, rankDesc, roundHalf, signedPct, slope, zMilli } from "./stats.ts";

export type ContextReport = components["schemas"]["ContextReport"];
type Signal = components["schemas"]["ContextSignal"];
type HistoryPeriod = components["schemas"]["HistoryPeriod"];

const obs = (r: EvidenceRow): Record<string, number> =>
  Object.fromEntries((JSON.parse(r.observations_json) as Array<{ metric_key: string; value: number }>).map((o) => [o.metric_key, o.value]));

export const HISTORY_KIND = "performance_review";
export const TIMELINESS_KIND = "delivery_timeliness";

export class ContextService {
  constructor(
    private readonly org: OrgRepo,
    private readonly evidence: EvidenceRepo,
    private readonly envelope: Envelope,
  ) {}

  /** Rating + manager note live in the encrypted payload; read them through the envelope. */
  private rawOf(r: EvidenceRow): { rating?: string; manager_note?: string; period_id?: string; period_label?: string } {
    const s = this.evidence.secrets(r.evidence_id);
    if (!s?.dek_wrapped || !s.payload_enc) return {};
    try {
      const dek = this.envelope.unwrap(s.dek_wrapped);
      const p = JSON.parse(this.envelope.decrypt(dek, s.payload_enc)) as { raw?: Record<string, string> };
      return p.raw ?? {};
    } catch {
      return {};
    }
  }

  history(employeeId: string, cycleId: string): Array<HistoryPeriod & { manager_note: string | null }> {
    return this.evidence
      .forEmployeeCycle(employeeId, cycleId)
      .filter((r) => r.kind === HISTORY_KIND && COUNTED.has(r.status))
      .sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1))
      .map((r) => {
        const o = obs(r);
        const raw = this.rawOf(r);
        return {
          period_id: raw.period_id ?? r.observed_at.slice(0, 10),
          period_label: raw.period_label ?? r.observed_at.slice(0, 7),
          score_bps: o.hist_score_bps ?? 0,
          targets_hit: o.hist_targets_hit ?? 0,
          targets_total: o.hist_targets_total ?? 0,
          deadlines_on_time: o.hist_deadlines_on_time ?? 0,
          deadlines_total: o.hist_deadlines_total ?? 0,
          avg_slip_days_x10: o.hist_slip_days_x10 ?? 0,
          rating: raw.rating ?? null,
          evidence_id: r.evidence_id,
          manager_note: raw.manager_note ?? null,
        };
      });
  }

  report(employeeId: string, cycleId: string, comp: ClusterComputation): ContextReport & { _notes: Array<string | null> } {
    const emp = this.org.employee(employeeId);
    if (!emp) throw errors.notFound("Employee not found");
    const clusterId = clusterIdOf(emp);
    if (!clusterId || clusterId !== comp.cluster.cluster_id) throw errors.validation("Employee is not in this cluster");
    const result = comp.results.get(employeeId);
    if (!result) throw errors.notFound("Employee has no result in this cluster");

    const hist = this.history(employeeId, cycleId);
    const timely = this.evidence
      .forEmployeeCycle(employeeId, cycleId)
      .filter((r) => r.kind === TIMELINESS_KIND && COUNTED.has(r.status))
      .sort((a, b) => (a.observed_at < b.observed_at ? -1 : 1))
      .pop();
    const t = timely ? obs(timely) : {};
    const kv = kraValues(comp.plan, result);
    const targetsTotal = comp.plan.kind === "tiered_commission" ? 1 : kv.length;
    const targetsHit = comp.plan.kind === "tiered_commission" ? (result.score_bps >= 10000 ? 1 : 0) : kv.filter((k) => k.attainment_ppm >= 1_000_000).length;
    const current = {
      score_bps: result.score_bps,
      deadlines_on_time: t.deadlines_on_time ?? 0,
      deadlines_total: t.deadlines_total ?? 0,
      avg_slip_days_x10: t.slip_days_x10 ?? 0,
      targets_hit: targetsHit,
      targets_total: targetsTotal,
    };

    const series = [...hist.map((h) => h.score_bps), result.score_bps];
    const sumHit = hist.reduce((a, h) => a + h.targets_hit, 0) + current.targets_hit;
    const sumTot = hist.reduce((a, h) => a + h.targets_total, 0) + current.targets_total;
    const sumOn = hist.reduce((a, h) => a + h.deadlines_on_time, 0) + current.deadlines_on_time;
    const sumDl = hist.reduce((a, h) => a + h.deadlines_total, 0) + current.deadlines_total;
    const stats = distStats(series);
    const trend = slope(series);
    const targetRate = sumTot ? roundHalf((sumHit / sumTot) * 10000) : 0;
    const onTimeRate = sumDl ? roundHalf((sumOn / sumDl) * 10000) : 0;
    const scores = comp.scores;
    const position = {
      rank: rankDesc(scores, result.score_bps),
      n: scores.length,
      percentile_bps: percentileBps(scores, result.score_bps),
      z_milli: zMilli(scores, result.score_bps),
      median_bps: distStats(scores).median,
    };

    // Signals: fixed rules and thresholds (documented in CR-004); the texts carry the exact numbers used.
    const signals: Signal[] = [];
    const periods = series.length;
    if (hist.length < 2) signals.push({ code: "limited_history", tone: "neutral", text: `Only ${hist.length} past review period(s) on record; trend is indicative.` });
    if (periods >= 3 && series.every((s) => s >= 9000)) signals.push({ code: "consistent_high_performer", tone: "positive", text: `Scored at or above 90.00% in all ${periods} periods (mean ${pct(stats.mean)}).` });
    if (periods >= 3 && trend >= 250) signals.push({ code: "improving", tone: "positive", text: `Improving by ${signedPct(trend)} per period across ${periods} periods.` });
    if (periods >= 3 && trend <= -250) signals.push({ code: "declining", tone: "negative", text: `Declining by ${signedPct(trend)} per period across ${periods} periods.` });
    if (periods >= 3 && stats.stdev >= 600) signals.push({ code: "volatile", tone: "neutral", text: `Scores vary by ${pct(stats.stdev)} (standard deviation) across periods.` });
    if (sumDl && onTimeRate >= 9000) signals.push({ code: "deadline_reliable", tone: "positive", text: `Met ${sumOn} of ${sumDl} committed deadlines (${pct(onTimeRate)}).` });
    if (sumDl && (onTimeRate < 7500 || current.avg_slip_days_x10 >= 30)) {
      signals.push({ code: "deadline_risk", tone: "negative", text: `Met ${sumOn} of ${sumDl} committed deadlines (${pct(onTimeRate)}); this cycle's average slip is ${days10(current.avg_slip_days_x10)} days.` });
    }
    if (current.targets_total && current.targets_hit === current.targets_total) signals.push({ code: "over_target", tone: "positive", text: `Hit all ${current.targets_total} targets this cycle.` });
    else if (current.targets_total && current.targets_hit * 2 <= current.targets_total) signals.push({ code: "under_target", tone: "negative", text: `Hit ${current.targets_hit} of ${current.targets_total} targets this cycle.` });
    if (position.n >= 3 && position.percentile_bps >= 7500) signals.push({ code: "above_cluster", tone: "positive", text: `Ranked ${position.rank} of ${position.n} in ${comp.cluster.label} (cluster median ${pct(position.median_bps)}).` });
    if (position.n >= 3 && position.percentile_bps <= 2500) signals.push({ code: "below_cluster", tone: "negative", text: `Ranked ${position.rank} of ${position.n} in ${comp.cluster.label} (cluster median ${pct(position.median_bps)}).` });

    const body = {
      employee_id: employeeId,
      cycle_id: cycleId,
      cluster_id: comp.cluster.cluster_id,
      history: hist.map(({ manager_note: _n, ...h }) => h),
      current,
      trend_bps_per_period: trend,
      mean_bps: stats.mean,
      volatility_bps: stats.stdev,
      target_hit_rate_bps: targetRate,
      on_time_rate_bps: onTimeRate,
      cluster_position: position,
      signals,
    };
    return { ...body, context_hash: keccakUtf8(canonicalJson({ schema: "pw.context.v1", ...body })), _notes: hist.map((h) => h.manager_note) };
  }
}
