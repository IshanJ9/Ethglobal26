"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, unwrap, type Schemas } from "@/lib/api";
import { Button, ErrorNote } from "@/components/ui";

type Checkpoint = Schemas["AgentCheckpoint"];
type Operation = Schemas["AgentOperation"];

/**
 * World ID Agent Pass human checkpoint. The review agent is paused; the human approves on their phone with World ID
 * (auth.world.org device flow, fresh Orb-class authentication). Our backend validates the ID token and binds the
 * approval to this exact operation; onApproved receives the checkpoint id the agent then runs under (once).
 */
export function AgentPassGate({ operation, onApproved, onClose }: { operation: Operation; onApproved: (checkpointId: string) => void; onClose: () => void }) {
  const [cp, setCp] = useState<Checkpoint | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const done = useRef(false);
  // one checkpoint per gate, even when React runs the effect twice (dev StrictMode)
  const created = useRef<Promise<Checkpoint> | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    (async () => {
      try {
        created.current ??= unwrap(api.POST("/v1/agent-pass/checkpoints", { body: { operation } }));
        let c = await created.current;
        if (stop) return;
        setCp(c);
        const tick = async () => {
          if (stop) return;
          try {
            c = await unwrap(api.GET("/v1/agent-pass/checkpoints/{checkpoint_id}", { params: { path: { checkpoint_id: c.checkpoint_id } } }));
            if (stop) return;
            setCp(c);
            if (c.status === "approved" && !done.current) {
              done.current = true;
              onApproved(c.checkpoint_id);
              return;
            }
            if (c.status === "pending") timer = setTimeout(tick, Math.max(2, c.interval_s) * 1000);
          } catch (e) {
            setErr(e);
          }
        };
        timer = setTimeout(tick, Math.max(2, c.interval_s) * 1000);
      } catch (e) {
        setErr(e);
      }
    })();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // operation is fixed for the life of the gate (a new operation needs a new checkpoint)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cancel() {
    if (cp?.status === "pending") {
      await unwrap(api.POST("/v1/agent-pass/checkpoints/{checkpoint_id}/cancel", { params: { path: { checkpoint_id: cp.checkpoint_id } } })).catch(() => null);
    }
    onClose();
  }

  const status = cp?.status;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="font-semibold">Human checkpoint · World ID Agent Pass</p>
        <span className="font-mono text-xs text-muted">{cp?.agent ?? "review-agent"} is paused</span>
      </div>
      <p className="mb-3 text-sm text-muted">
        The review agent is about to decrypt this employee’s evidence vault and write HR text about them. It runs only after an
        Orb-verified human approves this exact request with World ID. The approval works once and expires in 10 minutes.
      </p>
      <ErrorNote error={err} />
      {!cp && !err ? <p className="text-sm text-muted">Contacting World ID…</p> : null}
      {status === "pending" && cp ? (
        <div className="flex flex-wrap items-center gap-5">
          {cp.verification_uri_complete ? (
            <a href={cp.verification_uri_complete} target="_blank" rel="noreferrer" className="rounded-md bg-white p-2" aria-label="Open World ID approval">
              <QRCodeSVG value={cp.verification_uri_complete} size={148} />
            </a>
          ) : null}
          <div className="space-y-1 text-sm">
            <p>Scan with your phone, or open <a className="underline" href={cp.verification_uri ?? "#"} target="_blank" rel="noreferrer">{cp.verification_uri}</a> and enter</p>
            <p className="font-mono text-2xl tracking-widest">{cp.user_code}</p>
            <p className="text-xs text-muted">Operation <span className="font-mono">{cp.operation_hash.slice(0, 10)}…</span> · expires {new Date(cp.expires_at).toLocaleTimeString()}</p>
            <p className="animate-pulse text-xs text-muted">Waiting for approval…</p>
          </div>
        </div>
      ) : null}
      {status === "approved" ? <p className="text-sm text-chain">✓ Approved by a verified human ({cp?.world?.acr?.split("/").pop()}{cp?.world?.enrolled ? ", World ID linked to this account" : ""}). Running the agent…</p> : null}
      {status && !["pending", "approved"].includes(status) ? (
        <p className="text-sm text-danger">✗ {status}: {cp?.reason ?? "the agent stays blocked"}. The agent did not run.</p>
      ) : null}
      <div className="mt-3">
        <Button kind="secondary" onClick={cancel}>{status === "pending" ? "Cancel" : "Close"}</Button>
      </div>
    </div>
  );
}
