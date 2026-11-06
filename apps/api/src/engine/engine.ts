// TypeScript port of spec/reference/engine.mjs (spec/ENGINE.md). PURE: no I/O, no clock, no randomness,
// integers only (BigInt for anything money-sized), floor division on non-negative operands only.
// test/engine.*.test.ts proves this port equals the reference on vectors.json and seed-scenario.json.

export type Int = bigint | number | string;
const PPM = 1_000_000n;
const B = (x: Int): bigint => BigInt(x);

export class EngineInputError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "EngineInputError";
  }
}

export type Direction = "higher_better" | "lower_better";

export function attainmentPpm(direction: Direction, actual: Int, target: Int, capPpm: Int): bigint {
  const a = B(actual);
  const t = B(target);
  if (t <= 0n || a < 0n) throw new EngineInputError("bad_inputs: target must be > 0 and actual >= 0");
  if (direction === "higher_better") return (a * PPM) / t;
  if (a === 0n) return B(capPpm);
  return (t * PPM) / a;
}

export function curveInterp(curve: Array<[Int, Int]> | number[][], x: Int): bigint {
  const xv = B(x);
  const pts = curve.map(([a, b]) => [B(a), B(b)] as const);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] <= pts[i - 1][0] || pts[i][1] < pts[i - 1][1]) {
      throw new EngineInputError("curve must have increasing x and non-decreasing y");
    }
  }
  if (xv <= pts[0][0]) return pts[0][1];
  if (xv >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (xv >= x0 && xv <= x1) return y0 + ((xv - x0) * (y1 - y0)) / (x1 - x0);
  }
  throw new Error("unreachable");
}

export interface KraInput {
  kra_id: string;
  direction: Direction;
  actual: Int;
  target: Int;
  floor_ppm: Int;
  cap_ppm: Int;
  weight_bps: Int;
}

export function weightedScorecard(args: {
  kras: KraInput[];
  payout_curve: number[][];
  target_bonus?: Int;
  verified_ratio_bps?: Int;
  min_verified_ratio_bps?: Int;
}) {
  const { kras, payout_curve, target_bonus = "0", verified_ratio_bps = 10000, min_verified_ratio_bps = 0 } = args;
  let total = 0n;
  const lines = kras.map((k) => {
    const att = attainmentPpm(k.direction, k.actual, k.target, k.cap_ppm);
    let capped = att;
    if (capped < B(k.floor_ppm)) capped = B(k.floor_ppm);
    if (capped > B(k.cap_ppm)) capped = B(k.cap_ppm);
    const contrib = (B(k.weight_bps) * capped) / 10000n;
    total += contrib;
    return { kra_id: k.kra_id, attainment_ppm: Number(att), capped_ppm: Number(capped), contribution_ppm: Number(contrib) };
  });
  const scoreBps = (total + 50n) / 100n;
  const gate = B(verified_ratio_bps) >= B(min_verified_ratio_bps);
  const mult = gate ? curveInterp(payout_curve, scoreBps) : 0n;
  return {
    lines,
    score_ppm: Number(total),
    score_bps: Number(scoreBps),
    gate_passed: gate,
    multiplier_bps: Number(mult),
    bonus_amount: ((B(target_bonus) * mult) / 10000n).toString(),
  };
}

export function tieredCommission(args: { quota: Int; sales: Int; rate_bps: Int; accelerator_bps: Int; retention_bps?: Int }) {
  const quota = B(args.quota);
  const sales = B(args.sales);
  const rate = B(args.rate_bps);
  const acc = B(args.accelerator_bps);
  const retention = B(args.retention_bps ?? 10000);
  if (quota <= 0n || sales < 0n) throw new EngineInputError("bad_inputs: quota must be > 0 and sales >= 0");
  const base = ((sales < quota ? sales : quota) * rate) / 10000n;
  const over = sales > quota ? sales - quota : 0n;
  const accelerated = (over * rate * acc) / 100000000n;
  return {
    attainment_bps: Number((sales * 10000n) / quota),
    base: Number(base),
    accelerated: Number(accelerated),
    payout: Number(((base + accelerated) * retention) / 10000n),
  };
}

export interface BugCreditPolicy {
  severity: Record<string, { weight_milli: number; full_credit_count: number; tier_cap_milli: number }>;
  taper_bps: number;
}
export interface BugFix {
  severity: string;
  impact_bps?: Int;
  share_bps?: Int;
  self_introduced?: boolean;
}

export function bugCredit(fixes: BugFix[], policy: BugCreditPolicy) {
  const byTier: Record<string, bigint[]> = {};
  for (const f of fixes) {
    const cfg = policy.severity[f.severity];
    if (!cfg) throw new EngineInputError(`unknown severity ${f.severity}`);
    let v = B(cfg.weight_milli);
    v = (v * B(f.impact_bps ?? 10000)) / 10000n;
    v = (v * B(f.share_bps ?? 10000)) / 10000n;
    if (f.self_introduced) v = 0n;
    (byTier[f.severity] ??= []).push(v);
  }
  const tiers: Record<string, number> = {};
  let total = 0n;
  // Object insertion order follows first appearance in `fixes`, exactly like the reference.
  for (const [sev, vals] of Object.entries(byTier)) {
    const cfg = policy.severity[sev];
    vals.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    let s = 0n;
    vals.forEach((v, i) => {
      s += i < cfg.full_credit_count ? v : (v * B(policy.taper_bps)) / 10000n;
    });
    const cap = B(cfg.tier_cap_milli);
    const t = s < cap ? s : cap;
    tiers[sev] = Number(t);
    total += t;
  }
  return { tiers_milli: tiers, total_milli: Number(total) };
}

export function payoutSplit(targetBonus: Int, multiplierBps: Int, holdbackBps: Int) {
  const ent = (B(targetBonus) * B(multiplierBps)) / 10000n;
  const imm = (ent * (10000n - B(holdbackBps))) / 10000n;
  return { entitlement: ent.toString(), immediate: imm.toString(), held: (ent - imm).toString() };
}

export function revision(targetBonus: Int, paid: Int, held: Int, newMultiplierBps: Int) {
  const ent = (B(targetBonus) * B(newMultiplierBps)) / 10000n;
  const max0 = (x: bigint) => (x > 0n ? x : 0n);
  const heldRemaining = max0(ent - B(paid));
  return {
    new_entitlement: ent.toString(),
    held_remaining: heldRemaining.toString(),
    overpaid: max0(B(paid) - ent).toString(),
    forfeited: max0(B(held) - heldRemaining).toString(),
    extra_owed: max0(heldRemaining - B(held)).toString(),
  };
}

export function carryBlend(curBps: Int, priorBps: Int, wBps: Int): number {
  return Number((B(curBps) * (10000n - B(wBps)) + B(priorBps) * B(wBps)) / 10000n);
}

// ---- evidence -> actuals (ENGINE.md section 3) ----
export const COUNTED = new Set(["verified", "provisional", "vested"]);
export const CANDIDATE = new Set(["unverified", "verified", "provisional", "vested"]);

export interface EngineEvidence {
  evidence_id: string;
  status: string;
  kind: string;
  observed_at: string;
  observations: Array<{ metric_key: string; value: number }>;
  severity?: string | null;
  share_bps?: number;
  self_introduced?: boolean;
}

export interface EnginePlan {
  kind: string;
  target_bonus: string;
  payout_curve: number[][];
  kras: Array<{
    kra_id: string;
    direction: Direction;
    target: number;
    floor_ppm: number;
    cap_ppm: number;
    weight_bps: number;
    metric_key: string;
    agg: "sum" | "latest";
    source?: string;
  }>;
  bug_credit?: BugCreditPolicy;
  commission?: { quota: number; rate_bps: number; accelerator_bps: number; metric_key: string; retention_metric_key?: string | null };
  gates: { min_verified_ratio_bps: number };
  carry_forward?: { history_weight_bps: number };
}

const byAtThenId = (a: { at: string; id: string }, b: { at: string; id: string }) =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function verifiedRatioBps(evidence: EngineEvidence[]): number {
  const cand = evidence.filter((e) => CANDIDATE.has(e.status));
  if (cand.length === 0) return 10000;
  const ok = cand.filter((e) => COUNTED.has(e.status)).length;
  return Math.floor((ok * 10000) / cand.length);
}

/** Evidence must already be filtered to ONE employee + ONE cycle. Order-independent. */
export function actualsFromEvidence(plan: EnginePlan, evidence: EngineEvidence[]) {
  const counted = evidence.filter((e) => COUNTED.has(e.status));
  const actuals: Record<string, bigint> = {};
  for (const k of plan.kras) {
    if (k.source === "bug_credit") continue;
    const obs: Array<{ at: string; id: string; v: bigint }> = [];
    for (const e of counted) for (const o of e.observations) if (o.metric_key === k.metric_key) obs.push({ at: e.observed_at, id: e.evidence_id, v: B(o.value) });
    if (k.agg === "sum") actuals[k.kra_id] = obs.reduce((a, o) => a + o.v, 0n);
    else {
      obs.sort(byAtThenId);
      actuals[k.kra_id] = obs.length ? obs[obs.length - 1].v : 0n;
    }
  }
  let bc: ReturnType<typeof bugCredit> | null = null;
  if (plan.bug_credit) {
    const fixes = counted
      .filter((e) => e.kind === "bug_fixed" && e.severity)
      .map((e) => ({ severity: e.severity as string, share_bps: e.share_bps ?? 10000, self_introduced: !!e.self_introduced, impact_bps: 10000 }));
    bc = bugCredit(fixes, plan.bug_credit);
    for (const k of plan.kras) if (k.source === "bug_credit") actuals[k.kra_id] = B(bc.total_milli);
  }
  return { actuals, bugCredit: bc };
}

export function evaluatePlan(
  plan: EnginePlan,
  evidence: EngineEvidence[],
  opts: { priorBps?: number | null; overrideActuals?: Record<string, number> } = {},
) {
  const priorBps = opts.priorBps ?? null;
  const overrideActuals = opts.overrideActuals ?? {};
  const { actuals, bugCredit: bc } = actualsFromEvidence(plan, evidence);
  const kras: KraInput[] = plan.kras.map((k) => ({
    kra_id: k.kra_id,
    direction: k.direction,
    target: k.target,
    floor_ppm: k.floor_ppm,
    cap_ppm: k.cap_ppm,
    weight_bps: k.weight_bps,
    actual: String(overrideActuals[k.kra_id] ?? actuals[k.kra_id] ?? 0n),
  }));
  const ratio = verifiedRatioBps(evidence);
  const base = weightedScorecard({
    kras,
    payout_curve: plan.payout_curve,
    target_bonus: plan.target_bonus,
    verified_ratio_bps: ratio,
    min_verified_ratio_bps: plan.gates.min_verified_ratio_bps,
  });
  let scoreBps = base.score_bps;
  let mult = base.multiplier_bps;
  let bonus = base.bonus_amount;
  let carry: { prior_score_bps: number; history_weight_bps: number; blended_score_bps: number } | null = null;
  if (priorBps !== null && plan.carry_forward && plan.carry_forward.history_weight_bps > 0) {
    scoreBps = carryBlend(base.score_bps, priorBps, plan.carry_forward.history_weight_bps);
    mult = base.gate_passed ? Number(curveInterp(plan.payout_curve, scoreBps)) : 0;
    bonus = ((B(plan.target_bonus) * B(mult)) / 10000n).toString();
    carry = { prior_score_bps: priorBps, history_weight_bps: plan.carry_forward.history_weight_bps, blended_score_bps: scoreBps };
  }
  const lines = base.lines.map((l, i) => ({
    ...l,
    actual: Number(kras[i].actual),
    target: plan.kras[i].target,
    weight_bps: plan.kras[i].weight_bps,
  }));
  return {
    lines,
    score_ppm: base.score_ppm,
    score_bps: scoreBps,
    raw_score_bps: base.score_bps,
    carry_forward: carry,
    bug_credit: bc,
    verified_ratio_bps: ratio,
    gate_passed: base.gate_passed,
    multiplier_bps: mult,
    bonus_amount: bonus,
  };
}

/** Plans of kind tiered_commission. Whole currency units; bonus_amount base units = payout * 1_000_000. */
export function evaluateCommission(plan: EnginePlan, evidence: EngineEvidence[]) {
  if (!plan.commission) throw new EngineInputError("plan has no commission policy");
  const counted = evidence.filter((e) => COUNTED.has(e.status));
  const sumOf = (key: string) =>
    counted.reduce((a, e) => a + e.observations.filter((o) => o.metric_key === key).reduce((x, o) => x + B(o.value), 0n), 0n);
  const latestOf = (key: string): bigint | null => {
    const obs: Array<{ at: string; id: string; v: bigint }> = [];
    for (const e of counted) for (const o of e.observations) if (o.metric_key === key) obs.push({ at: e.observed_at, id: e.evidence_id, v: B(o.value) });
    obs.sort(byAtThenId);
    return obs.length ? obs[obs.length - 1].v : null;
  };
  const c = plan.commission;
  const retention = c.retention_metric_key ? (latestOf(c.retention_metric_key) ?? 10000n) : 10000n;
  const r = tieredCommission({ quota: c.quota, sales: sumOf(c.metric_key), rate_bps: c.rate_bps, accelerator_bps: c.accelerator_bps, retention_bps: retention });
  const ratio = verifiedRatioBps(evidence);
  const gate = ratio >= plan.gates.min_verified_ratio_bps;
  const payout = gate ? r.payout : 0;
  return {
    lines: [] as never[],
    score_ppm: r.attainment_bps * 100,
    score_bps: r.attainment_bps,
    commission: r,
    verified_ratio_bps: ratio,
    gate_passed: gate,
    multiplier_bps: gate ? 10000 : 0,
    bonus_amount: (B(payout) * 1000000n).toString(),
  };
}
