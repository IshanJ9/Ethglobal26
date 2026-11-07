"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, unwrap } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { isManager, useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { usePublicConfig } from "@/lib/config";
import { formatBps } from "@/lib/format";
import { useCycles, useEmployees, useEvidence, usePayout, usePlan, useScorecard } from "@/lib/queries";
import { EvidenceTable, PayoutPanel, RevisionDiff, ScoreBreakdown } from "@/components/scorecard";
import { ModeBadge } from "@/components/ModeBadge";
import { ZkCard } from "@/components/ZkCard";
import { Button, Card, ErrorNote, HashPill, Loading, Money, PageTitle, Stat, StatusChip, TextLink } from "@/components/ui";

export default function ScorecardPage() {
  const { id } = useParams<{ id: string }>();
  const me = useRequireSession();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: cfg } = usePublicConfig();
  const sc = useScorecard(id);
  const s = sc.data;
  const employees = useEmployees();
  const cycles = useCycles();
  const plan = usePlan(s?.result.plan_id);
  const evidence = useEvidence({ employee_id: s?.employee_id, cycle_id: s?.cycle_id });
  const prevId = s?.supersedes_scorecard_id ?? undefined;
  const prev = useScorecard(prevId ?? "");
  const diff = useQuery({
    queryKey: ["diff", id, prevId, me?.persona_id],
    queryFn: () => unwrap(api.GET("/v1/scorecards/{scorecard_id}/diff/{other_id}", { params: { path: { scorecard_id: id, other_id: prevId! } } })),
    enabled: !!prevId && !!me,
  });
  const attested = !!s?.attestation;
  const payout = usePayout(id, attested);
  useSignOutOnUnauthorized(sc.error, employees.error, evidence.error);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["scorecard", id] });
    qc.invalidateQueries({ queryKey: ["payout", id] });
    qc.invalidateQueries({ queryKey: ["scorecards"] });
  };

  const requestApproval = useAction(
    (scorecard_id: string, key) => unwrap(api.POST("/v1/approvals", { body: { scorecard_id }, ...idem(key) })),
    { onSuccess: (a) => router.push(`/approvals/${a.approval_id}`) },
  );
  const attest = useAction((scorecard_id: string, key) => unwrap(api.POST("/v1/chain/attest", { body: { scorecard_id }, ...idem(key) })), { onSuccess: refresh });
  const release = useAction(
    (scorecard_id: string, key) => unwrap(api.POST("/v1/payouts/{scorecard_id}/release", { params: { path: { scorecard_id } }, ...idem(key) })),
    { onSuccess: refresh },
  );
  const releaseHoldback = useAction(
    (scorecard_id: string, key) => unwrap(api.POST("/v1/payouts/{scorecard_id}/release-holdback", { params: { path: { scorecard_id } }, ...idem(key) })),
    { onSuccess: refresh },
  );
  const shred = useAction(
    (evidence_id: string, key) => unwrap(api.POST("/v1/evidence/{evidence_id}/shred", { params: { path: { evidence_id } }, ...idem(key) })),
    { onSuccess: () => qc.invalidateQueries({ queryKey: ["evidence"] }) },
  );
  const [disputeReason, setDisputeReason] = useState("");
  const dispute = useAction(
    (r: string, key) => unwrap(api.POST("/v1/payouts/{scorecard_id}/dispute", { params: { path: { scorecard_id: id } }, body: { reason: r }, ...idem(key) })),
    { onSuccess: () => { setDisputeReason(""); refresh(); } },
  );
  const resolve = useAction(
    (release_funds: boolean, key) => unwrap(api.POST("/v1/payouts/{scorecard_id}/resolve", { params: { path: { scorecard_id: id } }, body: { release_funds }, ...idem(key) })),
    { onSuccess: refresh },
  );
  const [reason, setReason] = useState("PR #101 reverted (regression)");
  const revise = useAction(
    (r: string, key) => unwrap(api.POST("/v1/scorecards/{scorecard_id}/revise", { params: { path: { scorecard_id: id } }, body: { reason: r }, ...idem(key) })),
    { onSuccess: (v2) => router.push(`/scorecards/${v2.scorecard_id}`) },
  );

  if (!me) return null;
  if (sc.isLoading) return <Loading what="Loading scorecard" />;
  if (!s) return <ErrorNote error={sc.error ?? new Error("Scorecard not found")} />;

  const emp = employees.data?.items.find((e) => e.employee_id === s.employee_id);
  const cycle = cycles.data?.items.find((c) => c.cycle_id === s.cycle_id);
  const labels = Object.fromEntries((plan.data?.kras ?? []).map((k) => [k.kra_id, k.label]));
  const evItems = (evidence.data?.items ?? []).filter((e) => s.evidence_ids.includes(e.evidence_id));
  const canAct = isManager(me) && me.employee_id !== s.employee_id;
  const chainMode = cfg?.chain_mode ?? "mock";
  const noPayout = payout.error instanceof ApiError && payout.error.status === 404;
  const p = payout.data;
  const actionError = requestApproval.error ?? attest.error ?? release.error ?? releaseHoldback.error ?? revise.error ?? dispute.error ?? resolve.error;
  const isHr = me.role === "hr";

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        crumbs={[{ label: "Team", href: "/team" }, { label: "Scorecard" }]}
        title={<>{emp?.display_name ?? s.employee_id} <span className="text-muted">· v{s.version}</span></>}
        sub={`${cycle?.label ?? s.cycle_id} · ${plan.data?.name ?? s.result.plan_id}`}
        right={<div className="flex items-center gap-2"><StatusChip status={s.status} /><Button kind="secondary" onClick={refresh}>Refresh</Button></div>}
      />

      {s.needs_revision ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-human/50 bg-human/10 px-3 py-2 text-sm text-human">
          <span>Evidence behind this scorecard changed (for example a reverted PR). It needs a revision.</span>
          {canAct ? (
            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) revise.mutate(reason.trim()); }}>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className="w-64 rounded border border-line bg-surface px-2 py-1 text-ink" aria-label="Revision reason" />
              <Button type="submit" disabled={revise.isPending}>{revise.isPending ? "Revising…" : "Create v" + (s.version + 1)}</Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {s.revision_reason ? <p className="text-sm text-muted">Revision of v{s.version - 1}: {s.revision_reason}</p> : null}

      <Card>
        <div className="flex flex-wrap gap-10">
          <Stat label="Score" value={formatBps(s.result.score_bps)} />
          <Stat label="Multiplier" value={formatBps(s.result.multiplier_bps)} />
          <Stat label="Bonus" value={<Money amount={s.result.bonus_amount} />} />
        </div>
      </Card>

      {prevId && diff.data ? (
        <Card title={`What changed since v${s.version - 1}`} right={<TextLink href={`/scorecards/${prevId}`}>Open v{s.version - 1}</TextLink>}>
          <RevisionDiff diff={diff.data} labels={labels} from={prev.data} to={s} />
        </Card>
      ) : null}

      {me ? <ZkCard scorecardId={s.scorecard_id} employeeId={s.employee_id} status={s.status} me={me} /> : null}

      <Card title="How the score was computed">
        <ScoreBreakdown result={s.result} labels={labels} />
      </Card>

      <Card title="Approval, proof and payout">
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col gap-3 text-sm">
            <li className="flex flex-wrap items-center justify-between gap-3">
              <span>1. Manager approval with World step-up</span>
              {s.approval_id ? (
                <TextLink href={`/approvals/${s.approval_id}`}>Open approval</TextLink>
              ) : canAct && s.status === "draft" ? (
                <Button onClick={() => requestApproval.mutate(s.scorecard_id)} disabled={requestApproval.isPending}>Request approval</Button>
              ) : (
                <span className="text-muted">not requested</span>
              )}
            </li>
            <li className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2">2. Attest on {cfg?.chain.name ?? "chain"} <ModeBadge mode={chainMode} /></span>
              {s.attestation ? (
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  attestation #{s.attestation.attestation_id}
                  {s.attestation.supersedes_attestation_id ? <> (supersedes #{s.attestation.supersedes_attestation_id})</> : null}
                  <HashPill value={s.attestation.tx_hash} href={s.attestation.explorer_url} />
                </span>
              ) : canAct && s.status === "approved" ? (
                <Button onClick={() => attest.mutate(s.scorecard_id)} disabled={attest.isPending}>{attest.isPending ? "Attesting…" : "Attest on chain"}</Button>
              ) : (
                <span className="text-muted">{s.status === "denied" ? "blocked: approval denied" : "after approval"}</span>
              )}
            </li>
            <li className="flex flex-wrap items-center justify-between gap-3">
              <span>3. Release the bonus from the vault</span>
              {canAct && attested && (noPayout || p?.status === "registered") && s.status === "attested" ? (
                <Button onClick={() => release.mutate(s.scorecard_id)} disabled={release.isPending}>{release.isPending ? "Releasing…" : "Release payout"}</Button>
              ) : canAct && p?.status === "active" ? (
                <Button kind="secondary" onClick={() => releaseHoldback.mutate(s.scorecard_id)} disabled={releaseHoldback.isPending}>Release holdback</Button>
              ) : (
                <span className="text-muted">{p ? p.status : "after attestation"}</span>
              )}
            </li>
          </ol>
          {canAct && p?.status === "active" ? (
            <form
              className="flex flex-wrap items-center gap-2 text-sm"
              onSubmit={(e) => { e.preventDefault(); if (disputeReason.trim()) dispute.mutate(disputeReason.trim()); }}
            >
              <span className="text-muted">Hold the remaining {p ? <Money amount={p.held} /> : null} while a problem is checked:</span>
              <input value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} placeholder="Reason" className="w-56 rounded border border-line px-2 py-1" aria-label="Dispute reason" />
              <Button kind="danger" type="submit" disabled={!disputeReason.trim() || dispute.isPending}>Dispute</Button>
            </form>
          ) : null}
          {canAct && p?.status === "disputed" ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Resolve the dispute:</span>
              <Button onClick={() => resolve.mutate(true)} disabled={resolve.isPending}>Release held amount</Button>
              <Button kind="danger" onClick={() => resolve.mutate(false)} disabled={resolve.isPending}>Forfeit held amount</Button>
            </div>
          ) : null}
          <ErrorNote error={actionError} />
          {p ? <PayoutPanel payout={p} chainMode={chainMode} /> : null}
          {s.score_commitment ? (
            <p className="text-xs text-muted">
              Score commitment <HashPill value={s.score_commitment} /> · evidence root <HashPill value={s.evidence_root} /> · subject <HashPill value={s.subject_id} /> ·{" "}
              <TextLink href={`/verify?kind=scorecard&id=${s.scorecard_id}`}>Verify publicly</TextLink>
            </p>
          ) : null}
        </div>
      </Card>

      <Card title={`Evidence (${evItems.length})`}>
        {evidence.isLoading ? (
          <Loading />
        ) : (
          <EvidenceTable items={evItems} onShred={isHr ? (eid) => shred.mutate(eid) : undefined} shredding={shred.isPending ? shred.variables : null} />
        )}
        <ErrorNote error={shred.error} className="mt-2" />
        {isHr ? <p className="mt-2 text-xs text-muted">Shredding erases a record&apos;s content on request (right to erasure). Its commitment and Merkle proof stay valid, so past scores remain verifiable.</p> : null}
      </Card>
    </div>
  );
}
