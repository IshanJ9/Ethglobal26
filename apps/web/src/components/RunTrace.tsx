"use client";

import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { AgentBadge } from "./identity";
import { InferenceTrace } from "./InferenceTrace";
import { ErrorNote, StatusChip } from "./ui";

const TOOL: Record<string, string> = { git: "Git", tickets: "Tickets", crm: "CRM", hris: "HRIS", worklog: "Work log" };

/** What the evidence agent did: which systems it called, what it found, and who it is (ENS + Agent Pass). */
export function RunTrace({ runId }: { runId: string }) {
  const pid = useSession()?.persona.persona_id;
  const run = useQuery({
    queryKey: ["run", runId, pid],
    queryFn: () => unwrap(api.GET("/v1/runs/{run_id}", { params: { path: { run_id: runId } } })),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "queued" || q.state.data.status === "running") ? 600 : false),
  });
  const r = run.data;
  if (!r) return <ErrorNote error={run.error} />;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-ai/30 bg-ai/5 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AgentBadge identity={r.agent_identity} />
        <StatusChip status={r.status} />
      </div>
      <ul className="flex flex-col gap-1">
        {r.tool_calls.map((t, i) => (
          <li key={`${t.tool}-${i}`} className="flex items-center gap-2">
            <span aria-hidden className={t.ok ? "text-chain" : "text-danger"}>{t.ok ? "✓" : "✗"}</span>
            <span className="font-medium">{TOOL[t.tool] ?? t.tool}</span>
            <span className="text-muted">{t.items_found ?? 0} items{t.note ? ` · ${t.note}` : ""}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{r.evidence_ids.length} evidence items recorded. The agent only collects; the engine computes the score.</p>
      {r.error ? <p className="text-danger">{r.error}</p> : null}
      {r.inference ? <InferenceTrace inference={r.inference} /> : null}
    </div>
  );
}
