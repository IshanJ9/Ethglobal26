// /v1/scores/compute and the compute step of scorecards (AGENT_A 3.2). Loads inputs, then calls the
// pure engine. Identical inputs -> byte-identical output (n11): fixed key order, sorted ids, no clock.
import { canonicalJson, keccakUtf8, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import { ApiError, errors } from "../errors.ts";
import type { EvidenceRepo, EvidenceRow } from "../db/evidence.ts";
import type { OrgRepo, Plan } from "../db/org.ts";
import type { ScorecardRepo } from "../db/scorecards.ts";
import {
  COUNTED,
  EngineInputError,
  evaluateCommission,
  evaluatePlan,
  type EngineEvidence,
  type EnginePlan,
} from "../engine/engine.ts";

export type ComputeRequest = components["schemas"]["ComputeRequest"];
export type ComputeResult = components["schemas"]["ComputeResult"];

const OPEN_ITEM_STATUSES = new Set(["disputed", "reverted"]);

export function toEngineEvidence(r: EvidenceRow): EngineEvidence {
  return {
    evidence_id: r.evidence_id,
    status: r.status,
    kind: r.kind,
    observed_at: r.observed_at,
    observations: JSON.parse(r.observations_json),
    severity: r.severity,
    share_bps: r.share_bps,
    self_introduced: !!r.self_introduced,
  };
}

export interface ComputeInputs {
  plan: Plan;
  evidence: EvidenceRow[];
  priorBps: number | null;
  openItems: string[];
}

export class ComputeService {
  constructor(
    private readonly org: OrgRepo,
    private readonly evidence: EvidenceRepo,
    private readonly scorecards: ScorecardRepo,
  ) {}

  loadInputs(planId: string, employeeId: string, cycleId: string, asOf?: string): ComputeInputs {
    const plan = this.org.plan(planId);
    if (!plan) throw errors.notFound(`Plan ${planId} not found`);
    const cycle = this.org.cycle(cycleId);
    if (!cycle) throw errors.notFound(`Cycle ${cycleId} not found`);
    let rows = this.evidence.forEmployeeCycle(employeeId, cycleId);
    if (asOf) {
      const t = Date.parse(asOf);
      rows = rows.filter((r) => Date.parse(r.observed_at) <= t);
    }
    let priorBps: number | null = null;
    let openItems: string[] = [];
    const prevCycle = this.org.cycleByNumeric(cycle.numeric_id - 1);
    if (prevCycle) {
      const prior = this.scorecards.latestFinal(employeeId, prevCycle.cycle_id);
      if (prior) priorBps = (JSON.parse(prior.result_json) as ComputeResult).score_bps;
      openItems = this.evidence
        .forEmployeeCycle(employeeId, prevCycle.cycle_id)
        .filter((r) => OPEN_ITEM_STATUSES.has(r.status))
        .map((r) => r.evidence_id)
        .sort();
    }
    return { plan, evidence: rows, priorBps, openItems };
  }

  compute(req: ComputeRequest): ComputeResult {
    const inputs = this.loadInputs(req.plan_id, req.employee_id, req.cycle_id, req.as_of);
    return this.evaluate(inputs, { employeeId: req.employee_id, overrideActuals: req.override_actuals });
  }

  /** Pure given its inputs. */
  evaluate(inputs: ComputeInputs, opts: { employeeId: string; overrideActuals?: Record<string, number> }): ComputeResult {
    const { plan, evidence, priorBps, openItems } = inputs;
    const warnings: string[] = [];
    const employee = this.org.employee(opts.employeeId);
    if (employee && employee.plan_id !== plan.plan_id) warnings.push(`plan ${plan.plan_id} is not the employee's assigned plan ${employee.plan_id}`);
    const override = opts.overrideActuals;
    if (override) {
      const known = new Set(plan.kras.map((k) => k.kra_id));
      const unknown = Object.keys(override).filter((k) => !known.has(k));
      if (unknown.length) throw errors.validation(`override_actuals has unknown kra_id(s): ${unknown.join(", ")}`);
      warnings.push("override_actuals applied (sandbox what-if; never persisted)");
    }

    const ev = evidence.map(toEngineEvidence);
    const enginePlan = plan as unknown as EnginePlan;
    try {
      let result: ComputeResult;
      if (plan.kind === "tiered_commission") {
        if (override) warnings.push("override_actuals ignored for tiered_commission plans");
        const r = evaluateCommission(enginePlan, ev);
        result = {
          plan_id: plan.plan_id,
          formula_hash: plan.formula_hash,
          lines: [],
          score_ppm: r.score_ppm,
          score_bps: r.score_bps,
          commission: r.commission,
          verified_ratio_bps: r.verified_ratio_bps,
          gate_passed: r.gate_passed,
          multiplier_bps: r.multiplier_bps,
          bonus_amount: r.bonus_amount,
          inputs_hash: "0x" as Hex,
        };
      } else {
        const r = evaluatePlan(enginePlan, ev, { priorBps, overrideActuals: override });
        const counted = evidence.filter((e) => COUNTED.has(e.status));
        result = {
          plan_id: plan.plan_id,
          formula_hash: plan.formula_hash,
          lines: r.lines.map((l, i) => {
            const k = plan.kras[i];
            const ids =
              override && override[k.kra_id] !== undefined
                ? []
                : k.source === "bug_credit"
                  ? counted.filter((e) => e.kind === "bug_fixed" && e.severity).map((e) => e.evidence_id)
                  : counted.filter((e) => (JSON.parse(e.observations_json) as Array<{ metric_key: string }>).some((o) => o.metric_key === k.metric_key)).map((e) => e.evidence_id);
            return {
              kra_id: l.kra_id,
              actual: l.actual,
              target: l.target,
              attainment_ppm: l.attainment_ppm,
              capped_ppm: l.capped_ppm,
              weight_bps: l.weight_bps,
              contribution_ppm: l.contribution_ppm,
              evidence_ids: ids.sort(),
            };
          }),
          score_ppm: r.score_ppm,
          score_bps: r.score_bps,
          ...(r.carry_forward ? { carry_forward: { ...r.carry_forward, open_items: openItems } } : {}),
          ...(r.bug_credit ? { bug_credit: r.bug_credit } : {}),
          verified_ratio_bps: r.verified_ratio_bps,
          gate_passed: r.gate_passed,
          multiplier_bps: r.multiplier_bps,
          bonus_amount: r.bonus_amount,
          inputs_hash: "0x" as Hex,
        };
        if (!r.carry_forward && openItems.length) warnings.push(`prior cycle has ${openItems.length} open item(s)`);
      }
      result.inputs_hash = inputsHash(plan.formula_hash, plan.kind === "tiered_commission" ? null : priorBps, override ?? null, evidence);
      if (warnings.length) result.warnings = warnings;
      return result;
    } catch (e) {
      if (e instanceof EngineInputError) throw new ApiError(422, "validation_failed", e.message);
      throw e;
    }
  }
}

/** HASHING.md section 4: inputs_hash over formula, prior score, overrides and evidence (id, status, commitment) sorted by id. */
export function inputsHash(
  formulaHash: string,
  priorBps: number | null,
  override: Record<string, number> | null,
  evidence: Array<Pick<EvidenceRow, "evidence_id" | "status" | "commitment">>,
): Hex {
  const ev = evidence
    .map((e) => ({ evidence_id: e.evidence_id, status: e.status, commitment: e.commitment }))
    .sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0));
  return keccakUtf8(canonicalJson({ formula_hash: formulaHash, prior_score_bps: priorBps, override_actuals: override, evidence: ev }));
}
