"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { usePublicConfig } from "@/lib/config";
import { formatBps } from "@/lib/format";
import { useEmployees, useScorecard } from "@/lib/queries";
import { requestWorldProof, type WorldResult } from "@/lib/world";
import { ModeBadge } from "@/components/ModeBadge";
import { ActorTag, Button, Card, ErrorNote, HashPill, Loading, Money, PageTitle, Stat, StatusChip, TextLink } from "@/components/ui";

export default function ApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const me = useRequireSession();
  const router = useRouter();
  const { data: cfg } = usePublicConfig();
  const approval = useQuery({
    queryKey: ["approval", id, me?.persona_id],
    queryFn: () => unwrap(api.GET("/v1/approvals/{approval_id}", { params: { path: { approval_id: id } } })),
    enabled: !!me,
  });
  const a = approval.data;
  const sc = useScorecard(a?.scorecard_id ?? "");
  const employees = useEmployees();
  useSignOutOnUnauthorized(approval.error, sc.error);
  const [world, setWorld] = useState<WorldResult | null>(null);
  const [comment, setComment] = useState("");
  const worldMode = cfg?.world_mode ?? "mock";

  const verify = useAction(
    async () => {
      if (!a) throw new Error("No approval");
      return requestWorldProof(worldMode, {
        action: a.world_action ?? "pw-approve-scorecard",
        signal: a.challenge,
        appId: cfg?.world_app_id,
        rpContext: (a as { world_rp_context?: unknown }).world_rp_context, // CR-002, when the API serves it
      });
    },
    { onSuccess: setWorld },
  );
  const complete = useAction(
    (decision: "approve" | "deny", key) =>
      unwrap(
        api.POST("/v1/approvals/{approval_id}/complete", {
          params: { path: { approval_id: id } },
          body: { decision, comment: comment.trim() || undefined, ...(decision === "approve" && world ? { world_result: world } : {}) },
          ...idem(key),
        }),
      ),
    { onSuccess: () => a && router.push(`/scorecards/${a.scorecard_id}`) },
  );

  if (!me) return null;
  if (approval.isLoading) return <Loading what="Loading approval" />;
  if (!a) return <ErrorNote error={approval.error ?? new Error("Approval not found")} />;
  const s = sc.data;
  const emp = employees.data?.items.find((e) => e.employee_id === s?.employee_id);
  const pending = a.status === "pending";

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageTitle title="Approve scorecard" sub={emp ? `${emp.display_name} · version ${s?.version}` : undefined} right={<StatusChip status={a.status} />} />

      <Card title="You are approving" right={s ? <TextLink href={`/scorecards/${s.scorecard_id}`}>Open scorecard</TextLink> : null}>
        {s ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-10">
              <Stat label="Score" value={formatBps(s.result.score_bps)} />
              <Stat label="Multiplier" value={formatBps(s.result.multiplier_bps)} />
              <Stat label="Bonus" value={<Money amount={s.result.bonus_amount} />} />
            </div>
            <p className="text-xs text-muted">
              <ActorTag actor="code" label={`Computed by the engine from ${s.evidence_ids.length} evidence items; gate ${s.result.gate_passed ? "passed" : "failed"}`} />
            </p>
          </div>
        ) : (
          <Loading />
        )}
      </Card>

      {pending ? (
        <Card title="Step 1 - prove you are a human" right={<ModeBadge mode={worldMode} />}>
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-muted">
              World checks a real, unique person is approving, bound to this approval only (challenge <HashPill value={a.challenge} />). Your role comes from sign-in, not from World.
            </p>
            {world ? (
              <p className="text-chain">✓ Human verified ({world.adapter === "mock" ? "mock" : world.adapter})</p>
            ) : (
              <div>
                <Button onClick={() => verify.mutate(undefined)} disabled={verify.isPending}>
                  {verify.isPending ? "Verifying…" : worldMode === "mock" ? "Mock World verification" : "Verify with World"}
                </Button>
              </div>
            )}
            <ErrorNote error={verify.error} />
          </div>
        </Card>
      ) : null}

      {pending ? (
        <Card title="Step 2 - decide">
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Comment (optional; required context for a denial)</span>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={500} className="rounded-md border border-line px-3 py-2" />
            </label>
            <div className="flex gap-3">
              <Button onClick={() => complete.mutate("approve")} disabled={!world || complete.isPending}>Approve</Button>
              <Button kind="danger" onClick={() => complete.mutate("deny")} disabled={complete.isPending}>Deny</Button>
            </div>
            <p className="text-xs text-muted">A denial is final for this version: it blocks attestation and payout.</p>
            <ErrorNote error={complete.error} />
          </div>
        </Card>
      ) : (
        <Card>
          <p className="text-sm">
            {a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : a.status}
            {a.decided_at ? ` on ${new Date(a.decided_at).toLocaleString()}` : ""}.
            {a.comment ? ` "${a.comment}"` : ""}
            {a.approval_proof_hash ? <> Proof <HashPill value={a.approval_proof_hash} /></> : null}
          </p>
        </Card>
      )}
    </div>
  );
}
