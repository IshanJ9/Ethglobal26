"use client";

import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { formatBps, formatUsdc } from "@/lib/format";
import { useReview } from "@/lib/queries";
import { ActorTag, Button, Card, ErrorNote, HashPill, Loading, PageTitle, Stat, StatusChip, TextLink } from "@/components/ui";
import { DistStrip, LayerHeader, SignalChips, SourceBadge, pctPpm, zText } from "@/components/review";

const READINESS = { ready: "Ready for promotion", on_track: "On track", not_yet: "Not yet" } as const;
const POSITION = { above_cluster: "Above the cluster", at_cluster: "At the cluster", below_cluster: "Below the cluster" } as const;

/** Evidence ids in text become links to the public verifier. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(evd_[0-9a-f]{20})/g);
  return (
    <>
      {parts.map((p, i) =>
        /^evd_[0-9a-f]{20}$/.test(p) ? (
          <a key={i} href={`/verify?type=evidence&id=${p}`} className="font-mono text-[11px] text-code underline decoration-code/30">
            {p.slice(0, 10)}…
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const me = useRequireSession();
  const qc = useQueryClient();
  const q = useReview(id);
  useSignOutOnUnauthorized(q.error);
  const anchor = useAction((_: string, key) => unwrap(api.POST("/v1/reviews/{review_id}/anchor", { params: { path: { review_id: id } }, ...idem(key) })), {
    onSuccess: (r) => qc.setQueryData(["review", id, me?.persona_id], r),
  });
  if (!me) return null;
  if (q.isLoading) return <Loading what="Loading review" />;
  const r = q.data;
  if (!r) return <ErrorNote error={q.error ?? new Error("Review not found")} />;
  const res = r.layer1.result;
  const ctx = r.context;
  const rs = r.reasoning;
  const plan = r.cluster.plan_name;
  const isHr = me.role === "hr";

  return (
    <div className="flex max-w-5xl flex-col gap-6 print:max-w-none">
      <PageTitle
        title={`${r.display_name} · bonus review`}
        sub={`${r.cluster.label} · ${plan} · ${r.cycle_id}`}
        right={
          <div className="flex items-center gap-2 print:hidden">
            <SourceBadge source={r.reasoning_source} />
            <Button kind="secondary" onClick={() => window.print()}>Print for the meeting</Button>
          </div>
        }
      />

      {/* ---------------- layer 1 ---------------- */}
      <Card>
        <div className="flex flex-col gap-4">
          <LayerHeader n={1} title="KRA score inside the cluster" who="code computes · same plan for every member" />
          <div className="flex flex-wrap gap-8">
            <Stat label="Score" value={formatBps(res.score_bps)} />
            <Stat label="Rank" value={`${r.layer1.rank} of ${r.layer1.n}`} sub={r.cluster.label} />
            <Stat label="Percentile" value={formatBps(r.layer1.percentile_bps)} />
            <Stat label="vs cluster mean" value={zText(r.layer1.z_milli)} />
            <Stat label="Multiplier" value={formatBps(res.multiplier_bps)} />
            <Stat label="Bonus" value={formatUsdc(res.bonus_amount)} />
          </div>
          <DistStrip
            stats={r.layer1.score_stats}
            values={[r.layer1.score_stats.min, r.layer1.score_stats.p25, r.layer1.score_stats.median, r.layer1.score_stats.p75, r.layer1.score_stats.max, res.score_bps]}
            highlight={[5]}
          />
          {res.lines.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3">KRA</th>
                  <th className="py-2 pr-3 text-right">Actual</th>
                  <th className="py-2 pr-3 text-right">Target</th>
                  <th className="py-2 pr-3 text-right">Attainment</th>
                  <th className="py-2 pr-3 text-right">Contribution</th>
                  <th className="py-2 pr-3">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {res.lines.map((l) => (
                  <tr key={l.kra_id} className="border-b border-line/60">
                    <td className="py-2 pr-3">{l.kra_id.replace(/_/g, " ")}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{l.actual.toLocaleString("en-US")}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{l.target.toLocaleString("en-US")}</td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${l.attainment_ppm >= 1_000_000 ? "text-chain" : "text-danger"}`}>{pctPpm(l.attainment_ppm)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{pctPpm(l.contribution_ppm)}</td>
                    <td className="py-2 pr-3 text-xs text-muted">{l.evidence_ids?.length ?? 0} items</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </Card>

      {r.peer ? (
        <Card title={`Same-cluster comparison: ${r.display_name} vs ${r.peer.peer_display_name}`} right={<ActorTag actor="code" label="Raw numbers from committed evidence" />}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">KRA</th>
                <th className="py-2 pr-3 text-right">{r.display_name}</th>
                <th className="py-2 pr-3 text-right">{r.peer.peer_display_name}</th>
                <th className="py-2 pr-3 text-right">Ratio</th>
                <th className="py-2 pr-3 text-right">Cluster median</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/60 font-medium">
                <td className="py-2 pr-3">Score</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatBps(r.peer.score_bps_self)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatBps(r.peer.score_bps_peer)}</td>
                <td />
                <td className="py-2 pr-3 text-right tabular-nums">{formatBps(r.layer1.score_stats.median)}</td>
              </tr>
              {r.peer.kras.map((k) => (
                <tr key={k.kra_id} className="border-b border-line/60">
                  <td className="py-2 pr-3">{k.label}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{k.self.toLocaleString("en-US")}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{k.peer.toLocaleString("en-US")}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{k.ratio_milli === null ? "n/a" : `${(k.ratio_milli / 1000).toFixed(2)}x`}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{k.cluster_median.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {/* ---------------- layer 2 ---------------- */}
      <Card>
        <div className="flex flex-col gap-4">
          <LayerHeader n={2} title="Context: how they performed before" who="code computes · HRIS reviews + ticket-system deadlines" />
          <div className="flex flex-wrap gap-8">
            <Stat label="Trend" value={`${ctx.trend_bps_per_period >= 0 ? "+" : ""}${(ctx.trend_bps_per_period / 100).toFixed(2)} pts`} sub="per period" />
            <Stat label="Average" value={formatBps(ctx.mean_bps)} sub={`σ ${formatBps(ctx.volatility_bps)}`} />
            <Stat label="Targets hit" value={formatBps(ctx.target_hit_rate_bps)} sub="all periods" />
            <Stat label="Deadlines met" value={formatBps(ctx.on_time_rate_bps)} sub="all periods" />
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Score by period</p>
              <div className="flex items-end gap-3">
                {[...ctx.history.map((h) => ({ label: h.period_label, score: h.score_bps, dl: `${h.deadlines_on_time}/${h.deadlines_total}`, rating: h.rating })), { label: "This cycle", score: ctx.current.score_bps, dl: `${ctx.current.deadlines_on_time}/${ctx.current.deadlines_total}`, rating: null }].map((p, i, all) => {
                  const max = Math.max(...all.map((a) => a.score), 10000);
                  return (
                    <div key={p.label} className="flex flex-1 flex-col items-center gap-1">
                      <span className="text-xs font-semibold tabular-nums">{formatBps(p.score)}</span>
                      <div className={`w-full rounded-t ${i === all.length - 1 ? "bg-ink" : "bg-code/40"}`} style={{ height: `${Math.max(8, (p.score / max) * 110)}px` }} />
                      <span className="text-[11px] text-muted">{p.label}</span>
                      <span className="text-[10px] text-muted">deadlines {p.dl}</span>
                      {p.rating ? <span className="text-[10px] text-muted">{p.rating.replace(/_/g, " ")}</span> : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Signals (fixed rules)</p>
              <SignalChips signals={ctx.signals} />
            </div>
          </div>
          <p className="text-xs text-muted">context hash <HashPill value={ctx.context_hash} /> · cluster position {ctx.cluster_position.rank} of {ctx.cluster_position.n}, median {formatBps(ctx.cluster_position.median_bps)}</p>
        </div>
      </Card>

      {/* ---------------- layer 3 ---------------- */}
      <Card>
        <div className="flex flex-col gap-4">
          <LayerHeader n={3} title="Reasoning for the review meeting" who={r.reasoning_source === "0g_private_computer" ? "AI writes, inside 0G Private Computer · every number checked against the data" : "deterministic writer · every number checked against the data"} />
          {r.fallback_reason ? <p className="rounded-md border border-human/40 bg-human/10 px-3 py-2 text-sm text-human">0G answer not used: {r.fallback_reason}. This text was written by code from the same packet.</p> : null}
          <h2 className="font-display text-2xl font-semibold leading-tight">{rs.headline}</h2>
          <p className="leading-relaxed"><Linked text={rs.summary} /></p>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-chain">Strengths</p>
              <ul className="list-disc space-y-1 pl-5 text-sm">{rs.strengths.map((s, i) => <li key={i}><Linked text={s} /></li>)}</ul>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-danger">To work on</p>
              <ul className="list-disc space-y-1 pl-5 text-sm">{rs.concerns.length ? rs.concerns.map((s, i) => <li key={i}><Linked text={s} /></li>) : <li className="text-muted">Nothing flagged.</li>}</ul>
            </div>
          </div>
          {rs.peer_comparison ? (
            <div className="rounded-md border border-line bg-paper px-3 py-2 text-sm">
              <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted">Peer comparison</span>
              <Linked text={rs.peer_comparison} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-ink/20 bg-surface px-3 py-3">
            <StatusChip status={POSITION[rs.recommendation.bonus_position]} tone={rs.recommendation.bonus_position === "above_cluster" ? "ok" : rs.recommendation.bonus_position === "below_cluster" ? "bad" : "info"} />
            <StatusChip status={READINESS[rs.recommendation.promotion_readiness]} tone={rs.recommendation.promotion_readiness === "ready" ? "ok" : rs.recommendation.promotion_readiness === "not_yet" ? "warn" : "info"} />
            <span className="text-sm"><Linked text={rs.recommendation.rationale} /></span>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Talking points</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">{rs.talking_points.map((s, i) => <li key={i}><Linked text={s} /></li>)}</ol>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">Citations ({rs.citations.length})</summary>
            <ul className="mt-2 space-y-1.5">
              {rs.citations.map((c, i) => (
                <li key={i} className="rounded border border-line/60 px-2 py-1.5">
                  {c.statement} <span className="text-xs text-muted">→ {c.refs.map((x, j) => <span key={j} className="mr-1"><Linked text={x} /></span>)}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </Card>

      {/* ---------------- proof ---------------- */}
      <Card title="Why this review can't be disputed" right={<ActorTag actor="chain" label="Chain proves" />}>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-semibold">Encrypted vault (0G Storage)</p>
            <p>
              {r.vault.items_total} evidence items read back from {r.vault.store_mode === "live" ? "0G Storage" : "the encrypted replica"} ({r.vault.from_0g} from the replica, {r.vault.from_org_db} from the org DB).{" "}
              <span className={r.vault.commitments_failed ? "text-danger" : "text-chain"}>
                {r.vault.commitments_matched} of {r.vault.items_total} decrypted payloads re-hash to their ledger commitment.
              </span>
            </p>
            <p className="font-semibold">Number check</p>
            <p className={r.number_check.passed ? "text-chain" : "text-danger"}>
              {r.number_check.passed ? `All ${r.number_check.numbers_checked} numbers in the text appear in the data packet` : `Unsupported numbers: ${r.number_check.unsupported.join(", ")}`} (attempts: {r.number_check.attempts}).
            </p>
            {r.inference ? (
              <>
                <p className="font-semibold">0G Private Computer</p>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted">Model</dt><dd className="font-mono">{r.inference.model}</dd>
                  <dt className="text-muted">Request</dt><dd className="font-mono break-all">{r.inference.request_id}</dd>
                  <dt className="text-muted">Provider</dt><dd><HashPill value={r.inference_provider} /></dd>
                  <dt className="text-muted">ZG-Res-Key</dt><dd className="font-mono break-all">{r.inference.zg_res_key ?? "-"}</dd>
                  <dt className="text-muted">TEE verdict</dt><dd>{r.inference.tee_verified === null ? "not reported by the router (request is end-to-end sealed)" : String(r.inference.tee_verified)}</dd>
                </dl>
              </>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-semibold">Hashes</p>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted">Data packet</dt><dd><HashPill value={r.hashes.packet_hash} /></dd>
              <dt className="text-muted">Context</dt><dd><HashPill value={r.hashes.context_hash} /></dd>
              <dt className="text-muted">Score inputs</dt><dd><HashPill value={r.hashes.inputs_hash} /></dd>
              <dt className="text-muted">Reasoning</dt><dd><HashPill value={r.hashes.output_hash} /></dd>
              <dt className="text-muted font-semibold">Review</dt><dd><HashPill value={r.hashes.review_hash} /></dd>
            </dl>
            <p className="font-semibold">On chain</p>
            {r.anchor ? (
              <p>
                Review hash anchored as batch {r.anchor.numeric_batch_id} ({r.anchor.chain_mode}){" "}
                <HashPill value={r.anchor.tx_hash} href={r.anchor.explorer_url} /> on {new Date(r.anchor.anchored_at).toLocaleString()}.
              </p>
            ) : isHr ? (
              <div className="flex flex-col gap-2 print:hidden">
                <p className="text-muted">Not anchored yet. Anchoring writes the review hash to the Arc registry so the employee can check this exact text later.</p>
                <Button onClick={() => anchor.mutate(r.review_id)} disabled={anchor.isPending}>{anchor.isPending ? "Anchoring on Arc…" : "Anchor review on chain"}</Button>
                <ErrorNote error={anchor.error} />
              </div>
            ) : (
              <p className="text-muted">Not anchored yet (HR anchors it).</p>
            )}
            <p className="text-xs text-muted">Prepared by {r.created_by} on {new Date(r.created_at).toLocaleString()}. <TextLink href={`/clusters?c=${r.cluster.cluster_id}`}>Open the cluster</TextLink></p>
          </div>
        </div>
      </Card>
    </div>
  );
}
