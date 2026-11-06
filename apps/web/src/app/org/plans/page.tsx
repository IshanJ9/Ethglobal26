"use client";

import { useQuery } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "@/lib/api";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { formatBps } from "@/lib/format";
import { Card, Empty, ErrorNote, HashPill, Loading, Money, PageTitle } from "@/components/ui";

const SOURCE: Record<string, string> = { git: "Git", tickets: "Tickets", crm: "CRM", hris: "HRIS", cosign: "Co-signed claims", bug_credit: "Bug-fix credit", worklog: "Work log" };
const ppm = (v: number) => `${(v / 10000).toFixed(0)}%`;

function PlanCard({ plan }: { plan: Schemas["Plan"] }) {
  return (
    <Card title={plan.name} right={<span className="text-xs text-muted">formula <HashPill value={plan.formula_hash} /></span>}>
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-wrap gap-x-8 gap-y-1 text-muted">
          <span>Target bonus <b className="text-ink"><Money amount={plan.target_bonus} /></b></span>
          <span>Holdback <b className="text-ink">{formatBps(plan.holdback_bps)}</b> for {plan.maturity_days} days</span>
          <span>Gate: at least <b className="text-ink">{formatBps(plan.gates.min_verified_ratio_bps)}</b> of evidence verified</span>
          {plan.carry_forward ? <span>Carry-forward <b className="text-ink">{formatBps(plan.carry_forward.history_weight_bps)}</b> of last cycle</span> : null}
        </div>
        {plan.kras.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">KRA</th>
                  <th className="py-2 pr-3 text-right font-medium">Weight</th>
                  <th className="py-2 pr-3 text-right font-medium">Target</th>
                  <th className="py-2 pr-3 font-medium">Better when</th>
                  <th className="py-2 pr-3 text-right font-medium">Cap</th>
                  <th className="py-2 pr-3 font-medium">Data source</th>
                  <th className="py-2 font-medium">Basis</th>
                </tr>
              </thead>
              <tbody>
                {plan.kras.map((k) => (
                  <tr key={k.kra_id} className="border-b border-line/60">
                    <td className="py-2 pr-3">{k.label}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatBps(k.weight_bps)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{k.target.toLocaleString("en-US")}</td>
                    <td className="py-2 pr-3">{k.direction === "higher_better" ? "higher" : "lower"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{ppm(k.cap_ppm)}</td>
                    <td className="py-2 pr-3">{SOURCE[(k as { source?: string }).source ?? ""] ?? (k as { source?: string }).source ?? "-"}</td>
                    <td className="py-2 font-mono text-xs text-muted">{k.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>This plan pays commission instead of KRA attainment.</Empty>
        )}
        {plan.payout_curve.length ? (
          <p className="text-xs text-muted">
            Payout curve (score → multiplier): {plan.payout_curve.map(([s, m]) => `${formatBps(s)} → ${formatBps(m)}`).join(" · ")}, linear in between.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

export default function PlansPage() {
  const me = useRequireSession();
  const plans = useQuery({ queryKey: ["plans", me?.persona_id], queryFn: () => unwrap(api.GET("/v1/org/plans")), enabled: !!me });
  useSignOutOnUnauthorized(plans.error);
  if (!me) return null;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Bonus plans" sub="What each role is measured on, where the data comes from, and how a score becomes a payout. The formula hash is what gets attested." />
      <ErrorNote error={plans.error} />
      {plans.isLoading ? <Loading /> : (plans.data?.items ?? []).map((p) => <PlanCard key={p.plan_id} plan={p} />)}
    </div>
  );
}
