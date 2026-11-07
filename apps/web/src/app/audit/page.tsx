"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { Button, Card, Empty, ErrorNote, HashPill, Loading, PageTitle } from "@/components/ui";

/** Hash-chained audit log (HR). The browser re-checks that every entry links to the one before it. */
export default function AuditPage() {
  const me = useRequireSession();
  const log = useInfiniteQuery({
    queryKey: ["audit", me?.persona_id],
    queryFn: ({ pageParam }) => unwrap(api.GET("/v1/audit", { params: { query: { limit: 100, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!me,
  });
  useSignOutOnUnauthorized(log.error);
  if (!me) return null;

  const items = (log.data?.pages.flatMap((p) => p.items) ?? []).slice().sort((a, b) => a.seq - b.seq);
  // Links are checked only between consecutive seq numbers that are both loaded.
  const broken = new Set<number>();
  for (let i = 1; i < items.length; i++) {
    if (items[i].seq === items[i - 1].seq + 1 && items[i].prev_hash !== items[i - 1].event_hash) broken.add(items[i].seq);
  }
  const shown = items.slice().reverse();

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        title="Audit log"
        sub="Every action, append-only. Each entry stores the hash of the one before it, so a deleted or edited entry breaks the chain."
        right={
          items.length > 1 ? (
            <span className={`rounded-full px-2.5 py-1 text-sm font-semibold ${broken.size ? "bg-danger/15 text-danger" : "bg-chain/15 text-chain"}`}>
              {broken.size ? `✗ ${broken.size} broken link(s)` : `✓ chain intact (${items.length} entries checked here)`}
            </span>
          ) : null
        }
      />
      <ErrorNote error={log.error} />
      <Card>
        {log.isLoading ? (
          <Loading />
        ) : shown.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left font-mono text-xs uppercase tracking-[0.04em] text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3 font-medium">#</th>
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Who</th>
                  <th className="py-2 pr-3 font-medium">Action</th>
                  <th className="py-2 pr-3 font-medium">On</th>
                  <th className="py-2 pr-3 font-medium">Hash</th>
                  <th className="py-2 font-medium">Previous</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.seq} className={`border-b border-line/60 ${broken.has(e.seq) ? "bg-danger/10" : ""}`}>
                    <td className="py-1.5 pr-3 tabular-nums text-muted">{e.seq}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(e.at).toLocaleString()}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{e.actor}</td>
                    <td className="py-1.5 pr-3">{e.action}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{e.subject}</td>
                    <td className="py-1.5 pr-3"><HashPill value={e.event_hash} /></td>
                    <td className="py-1.5"><HashPill value={e.prev_hash} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No audit entries visible to you.</Empty>
        )}
        {log.hasNextPage ? (
          <div className="mt-3">
            <Button kind="secondary" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>
              {log.isFetchingNextPage ? "Loading…" : "Load older entries"}
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
