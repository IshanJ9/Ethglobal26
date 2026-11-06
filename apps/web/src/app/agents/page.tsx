"use client";

import { useState } from "react";
import { api, unwrap, type Schemas } from "@/lib/api";
import { useRequireSession } from "@/lib/auth";
import { formatBps, formatUsdc } from "@/lib/format";
import { useClusters, useCurrentCycle } from "@/lib/queries";
import { Button, Card, ErrorNote, PageTitle } from "@/components/ui";

type Allocation = Schemas["BonusAllocation"];
type Chat = Schemas["PromotionChat"];
type Settlement = Schemas["BonusSettlement"];
type Msg = { role: "user" | "assistant"; content: string };

function AgentFoot({ a }: { a: Schemas["AgentTrace"] }) {
  return (
    <details className="mt-3 text-xs text-muted">
      <summary className="cursor-pointer">
        {a.ens_name}.proofwork-demo.eth · {a.model} on 0G Private Computer · {a.tool_calls.length} tool calls · request {a.request_ids[0]}
      </summary>
      <ol className="mt-2 list-decimal space-y-0.5 pl-5 font-mono">
        {a.tool_calls.map((t, i) => <li key={i}>{t.tool}({t.args === "{}" ? "" : t.args})</li>)}
      </ol>
    </details>
  );
}

function BonusPool({ cycleId }: { cycleId: string }) {
  const clusters = useClusters();
  const [cluster, setCluster] = useState("software.ic");
  const [budget, setBudget] = useState("10000");
  const [kind, setKind] = useState<Allocation["kind"]>("year_end_bonus");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [res, setRes] = useState<Allocation | null>(null);
  async function run() {
    setBusy(true); setErr(null); setRes(null);
    try {
      setRes(await unwrap(api.POST("/v1/agents/bonus-allocation", { body: { cycle_id: cycleId, cluster_id: cluster, budget: String(Math.round(Number(budget) * 1e6)), kind } })));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Card title="Bonus pool · allocation agent" right={<span className="text-xs text-muted">settles via the Arc Studio BonusPool (USDC)</span>}>
      <p className="mb-3 text-sm text-muted">
        Fund a pool for a peer cluster. The agent reads all three layers (KRA score in the cluster, context and trend, the HR review) through
        tool calls on 0G and adjusts each person&apos;s score-based share by at most ±15%, with a reason. Code enforces the budget to the cent.
        Year-end bonuses unlock after the period ends (holdback + dispute window); bounties and freelance pay on approval.
      </p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label><span className="mb-1 block text-muted">Cluster</span>
          <select value={cluster} onChange={(e) => setCluster(e.target.value)} className="rounded border border-line bg-surface px-2 py-1.5">
            {(clusters.data?.items ?? []).map((c) => <option key={c.cluster_id} value={c.cluster_id}>{c.label}</option>)}
          </select>
        </label>
        <label><span className="mb-1 block text-muted">Budget (USDC)</span>
          <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" className="w-32 rounded border border-line bg-surface px-2 py-1.5" />
        </label>
        <label><span className="mb-1 block text-muted">Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Allocation["kind"])} className="rounded border border-line bg-surface px-2 py-1.5">
            <option value="year_end_bonus">Year-end bonus</option><option value="bounty">Bounty</option><option value="freelance">Freelance</option>
          </select>
        </label>
        <Button onClick={run} disabled={busy}>{busy ? "Agent is reading the three layers…" : "Ask the agent to split it"}</Button>
      </div>
      <ErrorNote error={err} className="mt-3" />
      {res ? (
        <div className="mt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-1">Person</th><th>Score</th><th>Base</th><th>Agent</th><th>Share</th><th className="text-right">USDC</th></tr></thead>
              <tbody>
                {res.lines.map((l) => (
                  <tr key={l.employee_id} className="border-t border-line align-top">
                    <td className="py-1.5">{l.name}<div className="max-w-md text-xs text-muted">{l.reason}</div></td>
                    <td>{formatBps(l.score_bps)}</td><td>{formatBps(l.base_share_bps)}</td>
                    <td className={l.adjustment_bps > 0 ? "text-chain" : l.adjustment_bps < 0 ? "text-danger" : ""}>{l.adjustment_bps > 0 ? "+" : ""}{formatBps(l.adjustment_bps)}</td>
                    <td className="font-medium">{formatBps(l.share_bps)}</td>
                    <td className="text-right font-mono">{formatUsdc(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.excluded.length ? <p className="mt-2 text-xs text-muted">Below the 50% floor (no share): {res.excluded.map((e) => e.name).join(", ")}</p> : null}
          <p className="mt-3 text-sm"><span className="font-medium">Agent rationale:</span> {res.rationale}</p>
          <p className="mt-1 text-xs text-muted">Guardrails: {res.guardrails.join(" · ")}. Bucket {res.bucket_id.slice(0, 10)}…, rationale hash {res.rationale_hash.slice(0, 10)}…</p>
          <AgentFoot a={res.agent} />
          <Settle allocationId={res.allocation_id} />
        </div>
      ) : null}
    </Card>
  );
}

function Settle({ allocationId }: { allocationId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [st, setSt] = useState<Settlement | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try { setSt(await unwrap(api.POST("/v1/agents/bonus-allocation/{allocation_id}/settle", { params: { path: { allocation_id: allocationId } } }))); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="mt-4 rounded-lg border border-line p-3">
      {!st ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={go} disabled={busy}>{busy ? "Settling on Arc (4+ transactions)…" : "Settle on Arc BonusPool"}</Button>
          <span className="text-xs text-muted">HR funds the pool, the review agent proposes with its own key, HR approves, USDC is released. Contract built in Arc Studio.</span>
        </div>
      ) : (
        <div className="text-sm">
          <p className="font-medium text-chain">{st.status === "paid" ? "✓ Paid in USDC on Arc" : `✓ Approved on Arc. Locked by the contract until ${st.unlocks_at ? new Date(st.unlocks_at).toLocaleDateString() : "period end"} (year-end bonus), then holdback + dispute window.`}</p>
          <p className="text-xs text-muted">BonusPool {st.pool_contract.slice(0, 10)}… · on-chain allocation #{st.onchain_allocation_id} · {Number(st.budget_onchain) / 1e6} USDC on chain (testnet scale 1:{st.amount_divisor})</p>
          <ol className="mt-2 space-y-1 text-xs">
            {st.txs.map((t, i) => (
              <li key={i}><span className="font-medium">{t.step}</span> · {t.signed_by} · {t.explorer_url ? <a className="font-mono underline" href={t.explorer_url} target="_blank" rel="noreferrer">{t.tx_hash.slice(0, 12)}…</a> : <span className="font-mono">{t.tx_hash.slice(0, 12)}…</span>}</li>
            ))}
          </ol>
        </div>
      )}
      <ErrorNote error={err} className="mt-2" />
    </div>
  );
}

function PromotionChatCard({ cycleId }: { cycleId: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("One Senior Software Engineer moves to Product Manager. Keep engineering headcount the same. Who should move?");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [last, setLast] = useState<Chat | null>(null);
  async function send() {
    if (!input.trim()) return;
    const next = [...msgs, { role: "user" as const, content: input.trim() }];
    setMsgs(next); setInput(""); setBusy(true); setErr(null);
    try {
      const r = await unwrap(api.POST("/v1/agents/promotion-chat", { body: { cycle_id: cycleId, messages: next } }));
      setLast(r);
      setMsgs([...next, { role: "assistant", content: r.reply || "(plan below)" }]);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <Card title="Promotions · planning agent" right={<span className="text-xs text-muted">0G function calling over the three layers</span>}>
      <div className="mb-3 space-y-2">
        {msgs.map((m, i) => (
          <div key={i} className={`rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "ml-auto max-w-[80%] bg-ink text-surface" : "max-w-[90%] border border-line bg-surface"}`}>{m.content}</div>
        ))}
        {busy ? <p className="animate-pulse text-sm text-muted">The agent is ranking candidates…</p> : null}
      </div>
      {last?.moves.length ? (
        <ol className="mb-3 space-y-2 text-sm">
          {last.moves.map((m, i) => (
            <li key={i} className="rounded border border-line px-3 py-2">
              <span className="font-medium">{m.name}</span>: {m.from_cluster} → {m.to_cluster}
              {m.is_backfill ? <span className="ml-2 rounded bg-ai/10 px-1.5 text-xs text-ai">backfill</span> : null}
              {!m.valid ? <span className="ml-2 text-xs text-danger">✗ failed validation</span> : <span className="ml-2 text-xs text-chain">✓ validated</span>}
              <div className="text-xs text-muted">{m.reason}</div>
            </li>
          ))}
        </ol>
      ) : null}
      {last ? <AgentFoot a={last.agent} /> : null}
      <ErrorNote error={err} className="my-2" />
      <div className="mt-3 flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && send()} className="flex-1 rounded border border-line bg-surface px-3 py-2 text-sm" placeholder="e.g. We need one new team lead in Sales" />
        <Button onClick={send} disabled={busy}>Send</Button>
      </div>
    </Card>
  );
}

export default function AgentsPage() {
  const me = useRequireSession();
  const cycle = useCurrentCycle();
  if (!me) return null;
  if (me.role !== "hr") return <p className="text-sm text-muted">HR only.</p>;
  const cycleId = cycle.cycle?.cycle_id ?? "cyc_2026h2";
  return (
    <div className="space-y-6">
      <PageTitle title="HR agents" sub="Agents on 0G Private Computer that read the three review layers through tool calls. They propose; HR decides; payouts settle in USDC on Arc." />
      <BonusPool cycleId={cycleId} />
      <PromotionChatCard cycleId={cycleId} />
    </div>
  );
}
