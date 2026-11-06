"use client";

import Link from "next/link";
import { isManager, useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { formatBps } from "@/lib/format";
import { useClaims, useCurrentCycle, useEvidence, useScorecards } from "@/lib/queries";
import { ActorTag, Card, Empty, ErrorNote, Loading, Money, PageTitle, Stat, StatusChip, TextLink } from "@/components/ui";

const SOURCE_LABEL: Record<string, string> = {
  github: "Git", tickets: "Tickets", crm: "CRM", hris: "HRIS", worklog: "Work log", cosign: "Co-signed", manual: "Manual", dev: "Demo inject",
};

export default function HomePage() {
  const me = useRequireSession();
  const { cycle, ...cycles } = useCurrentCycle();
  const claims = useClaims(cycle?.cycle_id);
  const evidence = useEvidence({ employee_id: me?.employee_id, cycle_id: cycle?.cycle_id });
  const scorecards = useScorecards({ employee_id: me?.employee_id, cycle_id: cycle?.cycle_id });
  useSignOutOnUnauthorized(cycles.error, claims.error, evidence.error, scorecards.error);

  if (!me) return null;
  if (me.role === "external_cosigner") {
    return (
      <PageTitle title={`Hello, ${me.display_name}`} sub="Co-signers do not have a dashboard. Open the co-sign link you were sent to review a claim." />
    );
  }

  const myClaims = (claims.data?.items ?? []).filter((c) => c.employee_id === me.employee_id);
  const sc = [...(scorecards.data?.items ?? [])].sort((a, b) => b.version - a.version)[0];
  const ev = evidence.data?.items ?? [];
  const bySource = Object.entries(
    ev.reduce<Record<string, { total: number; verified: number }>>((acc, e) => {
      const s = (acc[e.source] ??= { total: 0, verified: 0 });
      s.total++;
      if (e.status === "verified" || e.status === "vested") s.verified++;
      return acc;
    }, {}),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        title="My cycle"
        sub={cycle ? `${cycle.label} · ${cycle.starts_on} to ${cycle.ends_on}` : cycles.isLoading ? "Loading cycle…" : "No cycle"}
        right={
          isManager(me) ? (
            <Link href="/team" className="rounded-md bg-ink px-3.5 py-2 text-sm font-medium text-surface">My team</Link>
          ) : null
        }
      />
      <ErrorNote error={cycles.error} />

      <Card title="Scorecard" right={sc ? <StatusChip status={sc.status} /> : null}>
        {scorecards.isLoading ? (
          <Loading />
        ) : sc ? (
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="flex flex-wrap gap-10">
              <Stat label="Score" value={formatBps(sc.result.score_bps)} sub={<ActorTag actor="code" label="computed by the engine" />} />
              <Stat label="Multiplier" value={formatBps(sc.result.multiplier_bps)} />
              <Stat label="Bonus" value={<Money amount={sc.result.bonus_amount} />} sub={`version ${sc.version}`} />
            </div>
            <TextLink href={`/scorecards/${sc.scorecard_id}`}>Open scorecard</TextLink>
          </div>
        ) : (
          <Empty>No scorecard yet. Your manager creates it once evidence is collected.</Empty>
        )}
        <ErrorNote error={scorecards.error} className="mt-3" />
      </Card>

      <div className="grid gap-6 md:grid-cols-[3fr_2fr]">
        <Card
          title="My claims"
          right={<Link href="/claims/new" className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface">New claim</Link>}
        >
          {claims.isLoading ? (
            <Loading />
          ) : myClaims.length ? (
            <ul className="divide-y divide-line">
              {myClaims.map((c) => (
                <li key={c.claim_id}>
                  <Link href={`/claims/${c.claim_id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-paper">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.body.summary || "Untitled claim"}</span>
                      <span className="block text-xs text-muted">{c.kra_id.replace(/_/g, " ")} · co-signer {c.cosigner_label}</span>
                    </span>
                    <StatusChip status={c.state} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No claims yet. Record work that only a client can confirm, like a call or a sign-off.</Empty>
          )}
          <ErrorNote error={claims.error} className="mt-3" />
        </Card>

        <Card title="Evidence">
          {evidence.isLoading ? (
            <Loading />
          ) : bySource.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {bySource.map(([source, s]) => (
                <li key={source} className="flex items-center justify-between">
                  <span>{SOURCE_LABEL[source] ?? source}</span>
                  <span className="tabular-nums text-muted">
                    {s.verified}/{s.total} verified
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No evidence collected for this cycle yet.</Empty>
          )}
          <p className="mt-3 text-xs text-muted">
            <ActorTag actor="ai" label="Collected by the evidence agent from systems of record" />
          </p>
          <ErrorNote error={evidence.error} className="mt-3" />
        </Card>
      </div>
    </div>
  );
}
