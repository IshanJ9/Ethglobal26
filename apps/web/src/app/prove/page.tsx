"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { useRequireSession } from "@/lib/auth";
import { formatBps } from "@/lib/format";
import { encodeBundle, prove, type ProofBundle } from "@/lib/zk";
import { Button, Card, ErrorNote, HashPill, Loading, PageTitle, TextLink } from "@/components/ui";

function Prove() {
  const me = useRequireSession();
  const id = useSearchParams().get("scorecard") ?? "";
  const w = useQuery({
    queryKey: ["zk-witness", id, me?.persona_id],
    enabled: !!me && !!id,
    queryFn: () => unwrap(api.GET("/v1/scorecards/{scorecard_id}/zk-witness", { params: { path: { scorecard_id: id } } })),
  });
  const [threshold, setThreshold] = useState("80.00");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [bundle, setBundle] = useState<ProofBundle | null>(null);
  const [ms, setMs] = useState(0);
  const [copied, setCopied] = useState(false);

  if (!me) return null;
  if (!id) return <p className="text-sm text-muted">Open this page from one of your scorecards.</p>;
  const bps = Math.round(Number(threshold) * 100);
  const link = bundle && typeof window !== "undefined" ? `${window.location.origin}/prove/verify#${encodeBundle(bundle)}` : "";

  async function run() {
    if (!w.data) return;
    setBusy(true); setErr(null); setBundle(null); setCopied(false);
    const t0 = performance.now();
    try {
      setBundle(await prove(w.data, bps));
      setMs(Math.round(performance.now() - t0));
    } catch (e) {
      setErr(e instanceof Error && /Assert|below/.test(e.message) ? new Error("Your score is below that threshold, so no valid proof can be made. That is the point: the circuit cannot lie.") : e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Prove your score without revealing it" sub="Zero-knowledge proof (Groth16). Generated here in your browser; your score and salt never leave this device." />
      <ErrorNote error={w.error} />
      {w.isLoading ? <Loading what="Loading your private witness" /> : null}
      {w.data ? (
        <>
          <Card title="Your private inputs (stay on this device)">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <div><span className="text-muted">Score</span> <b>{formatBps(w.data.score_bps)}</b></div>
              <div><span className="text-muted">Salt</span> <span className="font-mono">{w.data.salt.slice(0, 6)}…{w.data.salt.slice(-4)}</span></div>
              <div><span className="text-muted">Public commitment</span> <HashPill value={"0x" + BigInt(w.data.commitment).toString(16).padStart(64, "0")} /></div>
              <div><span className="text-muted">Anchored on Arc, batch</span> {w.data.numeric_batch_id}</div>
            </div>
          </Card>
          <Card title="Statement to prove">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-muted">My score is at least (%)</span>
                <input value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" className="w-32 rounded border border-line bg-surface px-2 py-1.5" aria-label="Threshold percent" />
              </label>
              <Button onClick={run} disabled={busy || !(bps >= 0 && bps <= 65535)}>{busy ? "Generating proof…" : "Generate proof"}</Button>
            </div>
            <p className="mt-2 text-xs text-muted">Try a threshold above your score: the circuit refuses, because a false statement has no valid proof.</p>
            <ErrorNote error={err} className="mt-3" />
          </Card>
          {bundle ? (
            <Card title="Proof ready" right={<span className="text-xs text-muted">{ms} ms in the browser</span>}>
              <p className="mb-3 text-sm">
                Proves <b>score ≥ {formatBps(bundle.threshold_bps)}</b> for scorecard <span className="font-mono">{bundle.scorecard_id}</span>, against the commitment the company anchored on Arc. It reveals nothing else.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button kind="secondary" onClick={() => { navigator.clipboard.writeText(link); setCopied(true); }}>{copied ? "Link copied" : "Copy share link"}</Button>
                <TextLink href={link.replace(window.location.origin, "")}>Open the verifier →</TextLink>
              </div>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default function ProvePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Prove />
    </Suspense>
  );
}
