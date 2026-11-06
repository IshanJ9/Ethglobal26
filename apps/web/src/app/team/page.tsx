"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { isManager, useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { formatBps } from "@/lib/format";
import { useCurrentCycle, useEmployees, useScorecards } from "@/lib/queries";
import { Button, Card, Empty, ErrorNote, Loading, Money, PageTitle, StatusChip } from "@/components/ui";

function Row({ emp, cards, cycleId }: { emp: Schemas["Employee"]; cards: Schemas["Scorecard"][]; cycleId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const latest = cards.filter((c) => c.employee_id === emp.employee_id).sort((a, b) => b.version - a.version)[0];

  const collect = useAction(
    (_: string, key) => unwrap(api.POST("/v1/runs", { body: { employee_id: emp.employee_id, cycle_id: cycleId }, ...idem(key) })),
    { onSuccess: () => qc.invalidateQueries({ queryKey: ["evidence"] }) },
  );
  const create = useAction(
    (_: string, key) => unwrap(api.POST("/v1/scorecards", { body: { employee_id: emp.employee_id, cycle_id: cycleId }, ...idem(key) })),
    { onSuccess: (sc) => router.push(`/scorecards/${sc.scorecard_id}`) },
  );

  return (
    <tr className="border-b border-line/60 align-middle">
      <td className="py-2.5 pr-3">
        <div className="font-medium">{emp.display_name}</div>
        <div className="text-xs text-muted">{emp.level.replace(/_/g, " ")} · {emp.ens_name ?? "ENS not resolved"}</div>
      </td>
      <td className="py-2.5 pr-3 text-right tabular-nums">{latest ? formatBps(latest.result.score_bps) : "-"}</td>
      <td className="py-2.5 pr-3 text-right tabular-nums">{latest ? formatBps(latest.result.multiplier_bps) : "-"}</td>
      <td className="py-2.5 pr-3 text-right">{latest ? <Money amount={latest.result.bonus_amount} /> : "-"}</td>
      <td className="py-2.5 pr-3">
        {latest ? (
          <span className="flex flex-wrap items-center gap-1">
            <StatusChip status={latest.status} /> <span className="text-xs text-muted">v{latest.version}</span>
            {latest.needs_revision ? <StatusChip status="needs revision" tone="warn" /> : null}
          </span>
        ) : (
          <span className="text-xs text-muted">no scorecard</span>
        )}
      </td>
      <td className="py-2.5 text-right">
        <div className="flex justify-end gap-2">
          {latest ? (
            <Link href={`/scorecards/${latest.scorecard_id}`} className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-ink">Open</Link>
          ) : (
            <>
              <Button kind="secondary" onClick={() => collect.mutate(emp.employee_id)} disabled={collect.isPending}>
                {collect.isPending ? "Collecting…" : collect.isSuccess ? "Collected" : "Run evidence agent"}
              </Button>
              <Button onClick={() => create.mutate(emp.employee_id)} disabled={create.isPending}>{create.isPending ? "Scoring…" : "Create scorecard"}</Button>
            </>
          )}
        </div>
        <ErrorNote error={collect.error ?? create.error} className="mt-1 text-left" />
      </td>
    </tr>
  );
}

export default function TeamPage() {
  const me = useRequireSession();
  const { cycle, ...cycles } = useCurrentCycle();
  const employees = useEmployees();
  const scorecards = useScorecards({ cycle_id: cycle?.cycle_id });
  useSignOutOnUnauthorized(employees.error, scorecards.error, cycles.error);
  if (!me) return null;
  if (!isManager(me)) return <PageTitle title="My team" sub="Only managers and HR see a team view." />;

  const team = (employees.data?.items ?? []).filter((e) => e.employee_id !== me.employee_id);
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="My team" sub={cycle ? `${cycle.label} · ${cycle.starts_on} to ${cycle.ends_on}` : undefined} />
      <Card>
        {employees.isLoading || !cycle ? (
          <Loading />
        ) : team.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">Person</th>
                  <th className="py-2 pr-3 text-right font-medium">Score</th>
                  <th className="py-2 pr-3 text-right font-medium">Multiplier</th>
                  <th className="py-2 pr-3 text-right font-medium">Bonus</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {team.map((e) => <Row key={e.employee_id} emp={e} cards={scorecards.data?.items ?? []} cycleId={cycle.cycle_id} />)}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No one reports to you.</Empty>
        )}
        <ErrorNote error={employees.error ?? scorecards.error} className="mt-3" />
      </Card>
    </div>
  );
}
