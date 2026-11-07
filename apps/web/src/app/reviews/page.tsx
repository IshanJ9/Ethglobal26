"use client";

import Link from "next/link";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { formatBps } from "@/lib/format";
import { useCurrentCycle, useReviews } from "@/lib/queries";
import { Card, Empty, ErrorNote, HashPill, Loading, PageTitle, TextLink } from "@/components/ui";
import { SourceBadge } from "@/components/review";

export default function ReviewsPage() {
  const me = useRequireSession();
  const { cycle } = useCurrentCycle();
  const q = useReviews({ cycle_id: cycle?.cycle_id });
  useSignOutOnUnauthorized(q.error);
  if (!me) return null;
  const canPrepare = me.role === "hr" || me.role === "manager";
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        title="Bonus reviews"
        sub="Three layers per person: KRA score inside the peer cluster, context from past periods, and reasoning written inside 0G Private Computer from the encrypted evidence."
        right={canPrepare ? <TextLink href="/clusters">Prepare a review from a cluster →</TextLink> : null}
      />
      <Card>
        {q.isLoading ? <Loading /> : null}
        <ErrorNote error={q.error} />
        {q.data && !q.data.items.length ? <Empty>No reviews yet{canPrepare ? ". Open a cluster, tick a person (or two to compare) and prepare one." : "."}</Empty> : null}
        {q.data?.items.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">Person</th>
                <th className="py-2 pr-3">Headline</th>
                <th className="py-2 pr-3 text-right">Score</th>
                <th className="py-2 pr-3">Written by</th>
                <th className="py-2 pr-3">On chain</th>
                <th className="py-2 pr-3" />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.review_id} className="border-b border-line/60 align-middle">
                  <td className="py-2 pr-3 font-medium">{r.display_name}<div className="text-xs text-muted">{r.cluster_id}{r.peer_employee_id ? " · with peer" : ""}</div></td>
                  <td className="py-2 pr-3">{r.headline}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatBps(r.score_bps)}</td>
                  <td className="py-2 pr-3"><SourceBadge source={r.reasoning_source} /></td>
                  <td className="py-2 pr-3">{r.anchor_tx_hash ? <HashPill value={r.anchor_tx_hash} /> : <span className="text-xs text-muted">not yet</span>}</td>
                  <td className="py-2 pr-3 text-right"><Link href={`/reviews/${r.review_id}`} className="rounded-full border border-line px-4 py-1.5 text-sm hover:border-accent">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
    </div>
  );
}
