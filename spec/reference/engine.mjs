// Reference scoring engine (plain JS, BigInt). INDEPENDENT of generate.py: if both agree on every vector,
// the arithmetic spec in spec/ENGINE.md is unambiguous across languages.
// Agent A: you may copy this into apps/api/src/engine/ and extend it, but it MUST keep passing `pnpm spec:check`.
// Rules: integers only, floor division on non-negative operands, BigInt for anything money-sized.

const PPM = 1_000_000n;
const B = (x) => BigInt(x);

export function attainmentPpm(direction, actual, target, capPpm) {
  actual = B(actual); target = B(target);
  if (target <= 0n || actual < 0n) throw new Error("bad_inputs");
  if (direction === "higher_better") return (actual * PPM) / target;
  if (actual === 0n) return B(capPpm);
  return (target * PPM) / actual;
}

export function curveInterp(curve, x) {
  x = B(x);
  const pts = curve.map(([a, b]) => [B(a), B(b)]);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] <= pts[i - 1][0] || pts[i][1] < pts[i - 1][1]) throw new Error("curve must have increasing x and non-decreasing y");
  }
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (x >= x0 && x <= x1) return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
  }
  throw new Error("unreachable");
}

export function weightedScorecard({ kras, payout_curve, target_bonus = "0", verified_ratio_bps = 10000, min_verified_ratio_bps = 0 }) {
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

export function tieredCommission({ quota, sales, rate_bps, accelerator_bps, retention_bps = 10000 }) {
  quota = B(quota); sales = B(sales); rate_bps = B(rate_bps); accelerator_bps = B(accelerator_bps); retention_bps = B(retention_bps);
  const base = ((sales < quota ? sales : quota) * rate_bps) / 10000n;
  const over = sales > quota ? sales - quota : 0n;
  const accelerated = (over * rate_bps * accelerator_bps) / 100000000n;
  return {
    attainment_bps: Number((sales * 10000n) / quota),
    base: Number(base),
    accelerated: Number(accelerated),
    payout: Number(((base + accelerated) * retention_bps) / 10000n),
  };
}

export function bugCredit(fixes, policy) {
  const byTier = {};
  for (const f of fixes) {
    const cfg = policy.severity[f.severity];
    let v = B(cfg.weight_milli);
    v = (v * B(f.impact_bps ?? 10000)) / 10000n;
    v = (v * B(f.share_bps ?? 10000)) / 10000n;
    if (f.self_introduced) v = 0n;
    (byTier[f.severity] ??= []).push(v);
  }
  const tiers = {};
  let total = 0n;
  for (const [sev, vals] of Object.entries(byTier)) {
    const cfg = policy.severity[sev];
    vals.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    let s = 0n;
    vals.forEach((v, i) => { s += i < cfg.full_credit_count ? v : (v * B(policy.taper_bps)) / 10000n; });
    const cap = B(cfg.tier_cap_milli);
    tiers[sev] = Number(s < cap ? s : cap);
    total += s < cap ? s : cap;
  }
  return { tiers_milli: tiers, total_milli: Number(total) };
}

export function payoutSplit(targetBonus, multiplierBps, holdbackBps) {
  const ent = (B(targetBonus) * B(multiplierBps)) / 10000n;
  const imm = (ent * (10000n - B(holdbackBps))) / 10000n;
  return { entitlement: ent.toString(), immediate: imm.toString(), held: (ent - imm).toString() };
}

export function revision(targetBonus, paid, held, newMultiplierBps) {
  const ent = (B(targetBonus) * B(newMultiplierBps)) / 10000n;
  const max0 = (x) => (x > 0n ? x : 0n);
  const heldRemaining = max0(ent - B(paid));
  return {
    new_entitlement: ent.toString(),
    held_remaining: heldRemaining.toString(),
    overpaid: max0(B(paid) - ent).toString(),
    forfeited: max0(B(held) - heldRemaining).toString(),
    extra_owed: max0(heldRemaining - B(held)).toString(),
  };
}

export function carryBlend(curBps, priorBps, wBps) {
  return Number((B(curBps) * (10000n - B(wBps)) + B(priorBps) * B(wBps)) / 10000n);
}

// ---- evidence -> actuals aggregation (spec/ENGINE.md section 3). JS reference is authoritative for this part. ----
export const COUNTED = new Set(["verified", "provisional", "vested"]);
export const CANDIDATE = new Set(["unverified", "verified", "provisional", "vested"]);

export function verifiedRatioBps(evidence) {
  const cand = evidence.filter((e) => CANDIDATE.has(e.status));
  if (cand.length === 0) return 10000;
  const ok = cand.filter((e) => COUNTED.has(e.status)).length;
  return Math.floor((ok * 10000) / cand.length);
}

/** Evidence items must already be filtered to ONE employee + ONE cycle. Order-independent. */
export function actualsFromEvidence(plan, evidence) {
  const counted = evidence.filter((e) => COUNTED.has(e.status));
  const actuals = {};
  for (const k of plan.kras) {
    if (k.source === "bug_credit") continue;
    const obs = [];
    for (const e of counted) for (const o of e.observations) if (o.metric_key === k.metric_key) obs.push({ at: e.observed_at, id: e.evidence_id, v: B(o.value) });
    if (k.agg === "sum") actuals[k.kra_id] = obs.reduce((a, o) => a + o.v, 0n);
    else {
      obs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      actuals[k.kra_id] = obs.length ? obs[obs.length - 1].v : 0n;
    }
  }
  if (plan.bug_credit) {
    const fixes = counted
      .filter((e) => e.kind === "bug_fixed" && e.severity)
      .map((e) => ({ severity: e.severity, share_bps: e.share_bps ?? 10000, self_introduced: !!e.self_introduced, impact_bps: 10000 }));
    const bc = bugCredit(fixes, plan.bug_credit);
    for (const k of plan.kras) if (k.source === "bug_credit") actuals[k.kra_id] = B(bc.total_milli);
    actuals.__bug_credit = bc;
  }
  return actuals;
}

/** Full deterministic evaluation of a progression plan against evidence. priorBps = prior cycle FINAL score (or null). */
export function evaluatePlan(plan, evidence, { priorBps = null, overrideActuals = {} } = {}) {
  const actuals = actualsFromEvidence(plan, evidence);
  const bc = actuals.__bug_credit; delete actuals.__bug_credit;
  const kras = plan.kras.map((k) => ({
    kra_id: k.kra_id, direction: k.direction, target: k.target, floor_ppm: k.floor_ppm, cap_ppm: k.cap_ppm, weight_bps: k.weight_bps,
    actual: String(overrideActuals[k.kra_id] ?? actuals[k.kra_id] ?? 0n),
  }));
  const ratio = verifiedRatioBps(evidence);
  const base = weightedScorecard({ kras, payout_curve: plan.payout_curve, target_bonus: plan.target_bonus, verified_ratio_bps: ratio, min_verified_ratio_bps: plan.gates.min_verified_ratio_bps });
  let scoreBps = base.score_bps, mult = base.multiplier_bps, bonus = base.bonus_amount, carry = null;
  if (priorBps !== null && plan.carry_forward && plan.carry_forward.history_weight_bps > 0) {
    scoreBps = carryBlend(base.score_bps, priorBps, plan.carry_forward.history_weight_bps);
    mult = base.gate_passed ? Number(curveInterp(plan.payout_curve, scoreBps)) : 0;
    bonus = ((B(plan.target_bonus) * B(mult)) / 10000n).toString();
    carry = { prior_score_bps: priorBps, history_weight_bps: plan.carry_forward.history_weight_bps, blended_score_bps: scoreBps };
  }
  const lines = base.lines.map((l, i) => ({ ...l, actual: Number(kras[i].actual), target: plan.kras[i].target, weight_bps: plan.kras[i].weight_bps }));
  return {
    lines, score_ppm: base.score_ppm, score_bps: scoreBps, raw_score_bps: base.score_bps, carry_forward: carry,
    bug_credit: bc ?? null, verified_ratio_bps: ratio, gate_passed: base.gate_passed, multiplier_bps: mult, bonus_amount: bonus,
  };
}

/** Plans of kind tiered_commission. Currency in whole units; bonus_amount base units = payout * 1_000_000. */
export function evaluateCommission(plan, evidence) {
  const counted = evidence.filter((e) => COUNTED.has(e.status));
  const sumOf = (key) => counted.reduce((a, e) => a + e.observations.filter((o) => o.metric_key === key).reduce((x, o) => x + B(o.value), 0n), 0n);
  const latestOf = (key) => {
    const obs = [];
    for (const e of counted) for (const o of e.observations) if (o.metric_key === key) obs.push({ at: e.observed_at, id: e.evidence_id, v: B(o.value) });
    obs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return obs.length ? obs[obs.length - 1].v : null;
  };
  const c = plan.commission;
  const retention = c.retention_metric_key ? latestOf(c.retention_metric_key) ?? 10000n : 10000n;
  const r = tieredCommission({ quota: c.quota, sales: sumOf(c.metric_key), rate_bps: c.rate_bps, accelerator_bps: c.accelerator_bps, retention_bps: retention });
  const ratio = verifiedRatioBps(evidence);
  const gate = ratio >= plan.gates.min_verified_ratio_bps;
  const payout = gate ? r.payout : 0;
  return {
    lines: [], score_ppm: r.attainment_bps * 100, score_bps: r.attainment_bps, commission: r, verified_ratio_bps: ratio, gate_passed: gate,
    multiplier_bps: gate ? 10000 : 0, bonus_amount: (B(payout) * 1000000n).toString(),
  };
}
