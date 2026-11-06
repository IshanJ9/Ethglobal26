"use client";

import type { Schemas } from "@/lib/api";
import { formatBps, formatUsdc } from "@/lib/format";
import { ChainScaleNote } from "./ChainScaleNote";
import { EnsAddress } from "./identity";
import { ModeBadge } from "./ModeBadge";
import { ActorTag, Empty, HashPill, Money, StatusChip } from "./ui";

const ppm = (v: number) => `${(v / 10000).toFixed(1)}%`;

export function ScoreBreakdown({ result, labels }: { result: Schemas["ComputeResult"]; labels: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 font-medium">KRA</th>
              <th className="py-2 pr-3 text-right font-medium">Actual</th>
              <th className="py-2 pr-3 text-right font-medium">Target</th>
              <th className="py-2 pr-3 text-right font-medium">Attainment</th>
              <th className="py-2 pr-3 text-right font-medium">After cap</th>
              <th className="py-2 pr-3 text-right font-medium">Weight</th>
              <th className="py-2 text-right font-medium">Contribution</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {result.lines.map((l) => (
              <tr key={l.kra_id} className="border-b border-line/60">
                <td className="py-2 pr-3">{labels[l.kra_id] ?? l.kra_id}</td>
                <td className="py-2 pr-3 text-right">{l.actual.toLocaleString("en-US")}</td>
                <td className="py-2 pr-3 text-right">{l.target.toLocaleString("en-US")}</td>
                <td className="py-2 pr-3 text-right">{ppm(l.attainment_ppm)}</td>
                <td className="py-2 pr-3 text-right">{ppm(l.capped_ppm)}</td>
                <td className="py-2 pr-3 text-right">{formatBps(l.weight_bps)}</td>
                <td className="py-2 text-right font-medium">{ppm(l.contribution_ppm)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        <ActorTag actor="code" label="Deterministic engine: attainment = actual / target (inverted for lower-is-better), capped, times weight. No AI in this step." />
        <span className="ml-2 font-mono">formula <HashPill value={result.formula_hash} /></span>
      </p>

      <div className={`rounded-md border px-3 py-2 text-sm ${result.gate_passed ? "border-chain/40 bg-chain/10 text-chain" : "border-danger/40 bg-danger/10 text-danger"}`}>
        Evidence verified {formatBps(result.verified_ratio_bps)} -{" "}
        {result.gate_passed ? "gate passed, a bonus can be paid." : "gate failed: too little evidence is verified yet to pay a bonus."}
      </div>

      {result.carry_forward?.prior_score_bps != null ? (
        <div className="rounded-md border border-code/40 bg-code/10 px-3 py-2 text-sm text-code">
          Carry-forward: last cycle {formatBps(result.carry_forward.prior_score_bps)} weighted{" "}
          {formatBps(result.carry_forward.history_weight_bps ?? 0)} gives a blended score of {formatBps(result.carry_forward.blended_score_bps ?? result.score_bps)}.
        </div>
      ) : null}

      {result.bug_credit?.tiers_milli ? (
        <div className="rounded-md border border-line px-3 py-2 text-sm">
          <div className="font-medium">Bug-fix credit: {((result.bug_credit.total_milli ?? 0) / 1000).toLocaleString("en-US")} points</div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
            {Object.entries(result.bug_credit.tiers_milli).map(([tier, v]) => (
              <span key={tier}>{tier}: {(v / 1000).toLocaleString("en-US")}</span>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">Severity-weighted and capped per tier, so one P0 fix outweighs twenty P3 fixes; bugs you introduced earn nothing.</p>
        </div>
      ) : null}

      {result.warnings?.length ? (
        <ul className="list-inside list-disc text-xs text-human">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      ) : null}
    </div>
  );
}

const SOURCE: Record<string, string> = { github: "Git", tickets: "Tickets", crm: "CRM", hris: "HRIS", worklog: "Work log", cosign: "Co-signed", manual: "Manual", dev: "Demo" };

export function EvidenceTable({
  items, onShred, shredding,
}: { items: Schemas["EvidenceItem"][]; onShred?: (id: string) => void; shredding?: string | null }) {
  if (!items.length) return <Empty>No evidence attached.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-line">
            <th className="py-2 pr-3 font-medium">Source</th>
            <th className="py-2 pr-3 font-medium">What</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Commitment</th>
            <th className="py-2 font-medium">Anchored</th>
            {onShred ? <th className="py-2 font-medium" /> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.evidence_id} className="border-b border-line/60 align-top">
              <td className="py-2 pr-3">
                <ActorTag actor={e.source === "cosign" ? "human" : "ai"} label={SOURCE[e.source] ?? e.source} />
              </td>
              <td className="py-2 pr-3">
                <div>{e.kind.replace(/_/g, " ")}{e.ref ? <span className="text-muted"> · {e.ref}</span> : null}{e.severity ? <span className="ml-1 rounded bg-paper px-1 text-xs">{e.severity}</span> : null}</div>
                <div className="text-xs text-muted">{e.observations.map((o) => `${o.metric_key} ${o.value}`).join(", ")}</div>
              </td>
              <td className="py-2 pr-3"><StatusChip status={e.status} /></td>
              <td className="py-2 pr-3"><HashPill value={e.commitment} /></td>
              <td className="py-2 text-xs">
                {e.batch_id ? (
                  <details>
                    <summary className="cursor-pointer">batch {e.batch_id}</summary>
                    <ul className="mt-1 font-mono">{(e.merkle_proof ?? []).map((h) => <li key={h}>{h.slice(0, 14)}…</li>)}</ul>
                  </details>
                ) : (
                  <span className="text-muted">not yet</span>
                )}
              </td>
              {onShred ? (
                <td className="py-2 text-right text-xs">
                  {e.status === "shredded" ? (
                    <span className="text-muted">erased</span>
                  ) : (
                    <button
                      onClick={() => {
                        if (window.confirm("Erase this record's content? Its hash and proof stay verifiable, but the data cannot be recovered.")) onShred(e.evidence_id);
                      }}
                      disabled={!!shredding}
                      className="rounded border border-danger/40 px-2 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-50"
                    >
                      {shredding === e.evidence_id ? "Erasing…" : "Shred"}
                    </button>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RevisionDiff({ diff, labels, from, to }: { diff: Schemas["ScorecardDiff"]; labels: Record<string, string>; from: Schemas["Scorecard"] | undefined; to: Schemas["Scorecard"] }) {
  const sign = (n: number) => (n > 0 ? "+" : "");
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <div className="text-xs uppercase text-muted">Score</div>
          <div className="tabular-nums">{from ? formatBps(from.result.score_bps) : "?"} → <b>{formatBps(to.result.score_bps)}</b> <span className={diff.score_bps_delta < 0 ? "text-danger" : "text-chain"}>({sign(diff.score_bps_delta)}{formatBps(diff.score_bps_delta)})</span></div>
        </div>
        <div>
          <div className="text-xs uppercase text-muted">Multiplier</div>
          <div className="tabular-nums">{from ? formatBps(from.result.multiplier_bps) : "?"} → <b>{formatBps(to.result.multiplier_bps)}</b></div>
        </div>
        <div>
          <div className="text-xs uppercase text-muted">Bonus</div>
          <div className="tabular-nums">{from ? formatUsdc(from.result.bonus_amount) : "?"} → <b>{formatUsdc(to.result.bonus_amount)}</b></div>
        </div>
      </div>
      {diff.line_changes.length ? (
        <ul className="flex flex-col gap-1">
          {diff.line_changes.map((l) => (
            <li key={l.kra_id}>
              {labels[l.kra_id] ?? l.kra_id}: {l.actual_from} → {l.actual_to} <span className="text-muted">({sign(l.contribution_ppm_delta)}{ppm(l.contribution_ppm_delta)} contribution)</span>
            </li>
          ))}
        </ul>
      ) : null}
      {diff.evidence_removed.length ? <p className="text-danger">Evidence removed: {diff.evidence_removed.join(", ")}</p> : null}
      {diff.evidence_added.length ? <p className="text-chain">Evidence added: {diff.evidence_added.join(", ")}</p> : null}
    </div>
  );
}

const PAY_STEPS: Schemas["PayoutStatus"][] = ["registered", "active", "closed"];
const PAY_LABEL: Record<string, string> = { none: "Not registered", registered: "Registered", active: "Released, holdback held", disputed: "Disputed", closed: "Closed" };

export function PayoutPanel({ payout, chainMode }: { payout: Schemas["Payout"]; chainMode: "mock" | "live" }) {
  const idx = PAY_STEPS.indexOf(payout.status);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <ol className="flex flex-wrap items-center gap-2">
        {PAY_STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 ${idx >= i ? "bg-ink text-surface" : "border border-line text-muted"}`}>{PAY_LABEL[s]}</span>
            {i < PAY_STEPS.length - 1 ? <span aria-hidden className="text-muted">→</span> : null}
          </li>
        ))}
        {payout.status === "disputed" ? <StatusChip status="disputed" /> : null}
      </ol>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 md:grid-cols-3">
        <div><dt className="text-xs uppercase text-muted">Target</dt><dd><Money amount={payout.target_bonus} /></dd></div>
        <div><dt className="text-xs uppercase text-muted">Entitlement</dt><dd className="font-semibold"><Money amount={payout.entitlement} /></dd></div>
        <div><dt className="text-xs uppercase text-muted">Paid</dt><dd><Money amount={payout.paid} /></dd></div>
        <div><dt className="text-xs uppercase text-muted">Held back</dt><dd><Money amount={payout.held} /></dd></div>
        <div><dt className="text-xs uppercase text-muted">Forfeited</dt><dd className={BigInt(payout.forfeited) > 0n ? "font-semibold text-danger" : ""}><Money amount={payout.forfeited} /></dd></div>
        <div><dt className="text-xs uppercase text-muted">Overpaid</dt><dd><Money amount={payout.overpaid} /></dd></div>
      </dl>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>Payee <EnsAddress address={payout.payee} /></span>
        {payout.maturity_at ? <span>Holdback matures {new Date(payout.maturity_at).toLocaleDateString()}</span> : null}
        {payout.last_tx_hash ? <span>Last tx <HashPill value={payout.last_tx_hash} href={payout.explorer_url} /></span> : null}
        <ModeBadge mode={chainMode} />
        <ChainScaleNote />
      </div>
    </div>
  );
}
