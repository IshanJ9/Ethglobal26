"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, unwrap, type Persona } from "@/lib/api";
import { useAction } from "@/lib/action";
import { isManager } from "@/lib/auth";
import { Button, Card, ErrorNote, HashPill, TextLink } from "@/components/ui";

/** Zero-knowledge section on a scorecard: HR/manager commits, the employee proves "score >= X". */
export function ZkCard({ scorecardId, employeeId, status, me }: { scorecardId: string; employeeId: string; status: string; me: Persona }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["zk", scorecardId],
    queryFn: async () => {
      try {
        return await unwrap(api.GET("/v1/scorecards/{scorecard_id}/zk-commit", { params: { path: { scorecard_id: scorecardId } } }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
  const commit = useAction(
    (_id: string) => unwrap(api.POST("/v1/scorecards/{scorecard_id}/zk-commit", { params: { path: { scorecard_id: scorecardId } } })),
    { onSuccess: () => qc.invalidateQueries({ queryKey: ["zk", scorecardId] }) },
  );
  const eligible = status === "approved" || status === "attested";
  const self = me.employee_id === employeeId;
  const z = q.data;

  return (
    <Card title="Zero-knowledge proof" right={<span className="text-xs text-muted">Groth16 · BN254 · verified on Arc</span>}>
      <p className="mb-3 text-sm text-muted">
        The company commits the score as <code>Poseidon(score, salt, scorecard)</code> and anchors it on Arc. The employee can then prove
        “my score is at least X” to anyone (a bank, a recruiter) without revealing the score. The proof is made in the browser.
      </p>
      <ErrorNote error={q.error ?? commit.error} />
      {z ? (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Commitment</span> <HashPill value={z.commitment_hex} />
            <span className="text-muted">anchored in batch {z.numeric_batch_id}</span> <HashPill value={z.tx_hash} href={z.explorer_url} />
          </div>
          {self ? (
            <TextLink href={`/prove?scorecard=${scorecardId}`}>Prove my score is above a threshold →</TextLink>
          ) : (
            <p className="text-muted">Only the employee can generate proofs; they hold the private witness.</p>
          )}
        </div>
      ) : q.isLoading ? null : isManager(me) && !self ? (
        <Button onClick={() => commit.mutate(scorecardId)} disabled={!eligible || commit.isPending}>
          {commit.isPending ? "Committing on Arc…" : eligible ? "Commit score for ZK proofs" : "Approve the scorecard first"}
        </Button>
      ) : (
        <p className="text-sm text-muted">Not committed yet. HR or the manager commits it after approval.</p>
      )}
    </Card>
  );
}
