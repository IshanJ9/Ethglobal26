"use client";

import { useEffect, useState } from "react";
import { formatBps } from "@/lib/format";
import { ARC_EXPLORER, ZK_PROOF_REGISTRY, decodeBundle, recordOnChain, verifyBundle, type ProofBundle, type VerifyResult } from "@/lib/zk";
import { Button, Card, ErrorNote, HashPill, Loading, PageTitle } from "@/components/ui";

const Mark = ({ ok, label, sub }: { ok: boolean | null; label: string; sub?: string }) => (
  <li className="flex items-start gap-3">
    <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-paper ${ok === null ? "bg-muted" : ok ? "bg-ok" : "bg-danger"}`}>{ok === null ? "?" : ok ? "✓" : "✗"}</span>
    <span><span className="font-medium">{label}</span>{sub ? <span className="block text-xs text-muted">{sub}</span> : null}</span>
  </li>
);

/** Public verifier: no login. Anyone with the link checks the proof locally and on Arc. */
export default function VerifyProofPage() {
  const [bundle, setBundle] = useState<ProofBundle | null>(null);
  const [res, setRes] = useState<VerifyResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [rec, setRec] = useState<{ busy: boolean; tx?: string | null; url?: string | null; error?: unknown }>({ busy: false });

  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (!h) { setErr(new Error("No proof in this link.")); return; }
    try {
      const b = decodeBundle(h);
      setBundle(b);
      verifyBundle(b).then(setRes, setErr);
    } catch (e) {
      setErr(e);
    }
  }, []);

  const all = res && res.local && res.onchain && res.anchored && res.binding;
  return (
    <div className="space-y-6">
      <PageTitle title="Verify a score proof" sub="Zero-knowledge: you learn that the statement is true, and nothing about the actual score." />
      <ErrorNote error={err} />
      {bundle ? (
        <Card title="Statement">
          <p className="text-lg">
            The employee’s score on scorecard <span className="font-mono text-base">{bundle.scorecard_id}</span> is <b>at least {formatBps(res?.threshold ?? bundle.threshold_bps)}</b>.
          </p>
          <p className="mt-1 text-xs text-muted">Proof made {new Date(bundle.created_at).toLocaleString()}. Circuit: score_threshold (Groth16 over BN254, Poseidon commitment).</p>
        </Card>
      ) : null}
      {bundle && !res && !err ? <Loading what="Verifying locally and on Arc" /> : null}
      {res ? (
        <Card title={all ? "Valid proof" : "Proof NOT valid"} right={<span className={`rounded px-2 py-0.5 text-xs font-semibold ${all ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"}`}>{all ? "VERIFIED" : "REJECTED"}</span>}>
          <ul className="space-y-3 text-sm">
            <Mark ok={res.local} label="Groth16 proof verifies in this browser" sub="snarkjs with the published verification key" />
            <Mark ok={res.onchain} label="Arc's ScoreThresholdVerifier contract accepts it" sub={`verifyProof() eth_call on ${bundle?.verifier_address}`} />
            <Mark ok={res.anchored} label="The commitment is the one the company anchored on Arc" sub={`registry.batchRoot(${bundle?.numeric_batch_id}) == commitment, so the employee could not pick their own score`} />
            <Mark ok={res.binding} label="Bound to this scorecard" sub="binding = keccak256(scorecard id) >> 8, a public input of the proof" />
            <Mark ok={res.recorded || !!rec.tx} label={res.recorded || rec.tx ? "Recorded permanently on Arc" : "Not yet recorded on chain"} sub={`ScoreProofRegistry ${ZK_PROOF_REGISTRY}: the contract re-verifies the proof and the anchored commitment before storing it`} />
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
            Commitment <HashPill value={res.commitmentHex} />
            Verifier <HashPill value={bundle?.verifier_address} href={`${ARC_EXPLORER}/address/${bundle?.verifier_address}`} />
          </div>
          {all && !res.recorded && !rec.tx ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={async () => { setRec({ busy: true }); try { const r = await recordOnChain(bundle!); setRec({ busy: false, tx: r.tx_hash, url: r.explorer_url }); setRes({ ...res, recorded: true }); } catch (e) { setRec({ busy: false, error: e }); } }} disabled={rec.busy}>
                {rec.busy ? "Recording on Arc…" : "Record this proof permanently on Arc"}
              </Button>
              <span className="text-xs text-muted">Free for you: Proofwork relays the transaction; the contract checks the proof itself.</span>
            </div>
          ) : null}
          {rec.tx ? <p className="mt-3 text-sm text-chain">Recorded on Arc · tx <HashPill value={rec.tx} href={rec.url} /></p> : null}
          <ErrorNote error={rec.error} className="mt-3" />
          {res.error ? <p className="mt-3 text-xs text-danger">Chain check error: {res.error}</p> : null}
        </Card>
      ) : null}
    </div>
  );
}
