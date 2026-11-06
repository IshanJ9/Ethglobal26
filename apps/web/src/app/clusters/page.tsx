"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, unwrap } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { formatBps, formatUsdc } from "@/lib/format";
import { useClusterBoard, useClusters, useCurrentCycle } from "@/lib/queries";
import { ActorTag, Button, Card, Empty, ErrorNote, HashPill, Loading, PageTitle, Stat } from "@/components/ui";
import { DistStrip, pctPpm, zText } from "@/components/review";

function ClustersInner() {
  const me = useRequireSession();
  const router = useRouter();
  const params = useSearchParams();
  const { cycle } = useCurrentCycle();
  const clusters = useClusters();
  const [cid, setCid] = useState<string | null>(params.get("c"));
  const [pick, setPick] = useState<string[]>([]);
  useEffect(() => {
    if (!cid && clusters.data?.items.length) {
      const mine = clusters.data.items.find((c) => c.department === me?.department);
      setCid((mine ?? clusters.data.items[0]).cluster_id);
    }
  }, [cid, clusters.data, me]);
  const board = useClusterBoard(cid ?? undefined, cycle?.cycle_id);
  useSignOutOnUnauthorized(clusters.error, board.error);
  const canReview = me?.role === "hr" || me?.role === "manager";

  const review = useAction(
    (ids: string[], key) =>
      unwrap(api.POST("/v1/reviews", { body: { employee_id: ids[0], cycle_id: cycle!.cycle_id, peer_employee_id: ids[1] ?? null }, ...idem(key) })),
    { onSuccess: (r) => router.push(`/reviews/${r.review_id}`) },
  );

  const b = board.data;
  const scores = useMemo(() => b?.rows.map((r) => r.score_bps) ?? [], [b]);
  if (!me) return null;

  const toggle = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  const name = (id: string) => b?.rows.find((r) => r.employee_id === id)?.display_name ?? id;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        title="Peer clusters"
        sub="Each cluster has its own KRA plan. People are only ranked and compared inside their own cluster, never across roles or levels."
      />

      <div className="flex flex-wrap gap-2">
        {clusters.data?.items.map((c) => (
          <button
            key={c.cluster_id}
            onClick={() => {
              setCid(c.cluster_id);
              setPick([]);
            }}
            className={`rounded-full border px-3 py-1.5 text-sm ${c.cluster_id === cid ? "border-ink bg-ink text-surface" : "border-line bg-surface hover:border-ink"}`}
          >
            {c.label} <span className="opacity-60">· {c.member_count}</span>
          </button>
        ))}
      </div>

      {board.isLoading ? <Loading what="Scoring every member with the cluster plan" /> : null}
      <ErrorNote error={board.error} />

      {b ? (
        <>
          <Card
            title={b.cluster.label}
            right={<ActorTag actor="code" label="Deterministic engine, same plan for everyone" />}
          >
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted">{b.cluster.description}</p>
              <div className="flex flex-wrap gap-8">
                <Stat label="Members" value={b.score_stats.n} />
                <Stat label="Median score" value={formatBps(b.score_stats.median)} />
                <Stat label="Middle half" value={`${formatBps(b.score_stats.p25)} – ${formatBps(b.score_stats.p75)}`} />
                <Stat label="Spread (σ)" value={formatBps(b.score_stats.stdev)} />
              </div>
              <DistStrip stats={b.score_stats} values={scores} highlight={b.rows.map((r, i) => (r.is_self || (r.employee_id && pick.includes(r.employee_id)) ? i : -1)).filter((i) => i >= 0)} />
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                <span>Plan <span className="font-medium text-ink">{b.cluster.plan_name}</span></span>
                <span>formula <HashPill value={b.formula_hash} /></span>
                <span>board hash <HashPill value={b.board_hash} /></span>
              </p>
            </div>
          </Card>

          <Card
            title="Ranking"
            right={
              canReview ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">{pick.length === 2 ? `${name(pick[0])} vs ${name(pick[1])}` : pick.length === 1 ? `${name(pick[0])} - pick a peer to compare, or review alone` : "Tick one person (or two to compare)"}</span>
                  <Button onClick={() => review.mutate(pick)} disabled={!pick.length || review.isPending}>
                    {review.isPending ? "0G is writing the reasoning…" : pick.length === 2 ? "Compare + review" : "Prepare review"}
                  </Button>
                </div>
              ) : null
            }
          >
            <ErrorNote error={review.error} className="mb-3" />
            {review.isPending ? (
              <p className="mb-3 rounded-md border border-ai/40 bg-ai/10 px-3 py-2 text-sm text-ai">
                Reading every evidence item back from the encrypted vault, re-checking each commitment, then asking 0G Private Computer for the review. This takes about 40 seconds.
              </p>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                    {canReview ? <th className="py-2 pr-2" /> : null}
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Person</th>
                    <th className="py-2 pr-3 text-right">Score</th>
                    <th className="py-2 pr-3 text-right">Percentile</th>
                    <th className="py-2 pr-3 text-right">vs mean</th>
                    {b.kra_stats.map((k) => (
                      <th key={k.kra_id} className="max-w-[7rem] py-2 pr-3 text-right font-medium normal-case" title={k.label}>
                        {k.label.replace(/\s*\(.*\)/, "")}
                      </th>
                    ))}
                    <th className="py-2 pr-3 text-right">Bonus</th>
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, i) => (
                    <tr key={r.employee_id ?? `anon-${i}`} className={`border-b border-line/60 ${r.is_self ? "bg-code/5" : ""}`}>
                      {canReview ? (
                        <td className="py-2 pr-2">
                          {r.employee_id ? <input type="checkbox" checked={pick.includes(r.employee_id)} onChange={() => toggle(r.employee_id!)} aria-label={`select ${r.display_name}`} /> : null}
                        </td>
                      ) : null}
                      <td className="py-2 pr-3 tabular-nums text-muted">{r.rank}</td>
                      <td className="py-2 pr-3 font-medium">{r.display_name}{r.is_self ? <span className="ml-1 text-xs text-code">(you)</span> : null}</td>
                      <td className="py-2 pr-3 text-right font-semibold tabular-nums">{formatBps(r.score_bps)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatBps(r.percentile_bps)}</td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${r.z_milli >= 0 ? "text-chain" : "text-danger"}`}>{zText(r.z_milli)}</td>
                      {r.kras.map((k) => (
                        <td key={k.kra_id} className="py-2 pr-3 text-right tabular-nums" title={`attainment ${pctPpm(k.attainment_ppm)}, ahead of ${formatBps(k.percentile_bps)} of the cluster`}>
                          <span className={k.attainment_ppm >= 1_000_000 ? "text-chain" : k.attainment_ppm < 700_000 ? "text-danger" : ""}>{k.actual.toLocaleString("en-US")}</span>
                        </td>
                      ))}
                      <td className="py-2 pr-3 text-right tabular-nums">{formatUsdc(r.bonus_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted">Green = at or above target, red = below 70% of target. Names of people outside your reporting line are hidden.</p>
          </Card>

          <Card title="Every KRA across the cluster" right={<ActorTag actor="code" label="Integer statistics, recomputable" />}>
            {b.kra_stats.length ? (
              <div className="grid gap-5 md:grid-cols-2">
                {b.kra_stats.map((k, j) => (
                  <div key={k.kra_id} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium">{k.label}</span>
                      <span className="text-xs text-muted">target {k.target.toLocaleString("en-US")}{k.direction === "lower_better" ? " (lower is better)" : ""}</span>
                    </div>
                    <DistStrip
                      stats={k.actual}
                      values={b.rows.map((r) => r.kras[j].actual)}
                      highlight={b.rows.map((r, i) => (r.is_self || (r.employee_id && pick.includes(r.employee_id)) ? i : -1)).filter((i) => i >= 0)}
                      format={(n) => n.toLocaleString("en-US")}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <Empty>No KRA lines for this plan.</Empty>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

export default function ClustersPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ClustersInner />
    </Suspense>
  );
}
