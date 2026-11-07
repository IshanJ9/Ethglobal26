"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { commit } from "@proofwork/crypto";
import { api, unwrap, type Schemas } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { Button, Card, ErrorNote, HashPill, PageTitle } from "@/components/ui";

type Kind = Schemas["VerifyRequest"]["kind"];
type CheckName = Schemas["VerifyResult"]["checks"][number]["name"];

const CHECK_TEXT: Record<CheckName, string> = {
  commitment_matches: "The value you were shown hashes to the stored commitment",
  merkle_proof_valid: "The commitment is inside the anchored Merkle tree",
  root_anchored_on_chain: "That Merkle root is recorded on chain",
  attestation_not_revoked: "The on-chain attestation is still current (not revoked or superseded)",
  employee_signature_valid: "The employee's EIP-712 signature recovers to their wallet",
  cosigner_signature_valid: "The co-signer's EIP-712 signature recovers to their wallet",
  hash_chain_intact: "The append-only evidence log is unbroken",
  formula_hash_matches: "The scoring formula matches the published plan",
  evidence_not_shredded: "The underlying record still exists (not erased on request)",
};

function parseJson(s: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  if (!s.trim()) return { ok: true, value: undefined };
  try {
    const v = JSON.parse(s);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "Must be a JSON object" };
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const isSalt = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s.trim());

function localCommit(value: string, salt: string): string | null {
  const v = parseJson(value);
  if (!v.ok || !v.value || !isSalt(salt)) return null;
  try {
    return commit(salt.trim() as Hex, v.value);
  } catch {
    return null;
  }
}

export default function VerifyPage() {
  const [kind, setKind] = useState<Kind>("scorecard");
  const [id, setId] = useState("");
  const [value, setValue] = useState("");
  const [salt, setSalt] = useState("");
  const [evValue, setEvValue] = useState("");
  const [evSalt, setEvSalt] = useState("");

  // Prefill from a shared link: /verify?kind=scorecard&id=scd_...
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const k = q.get("kind");
    if (k === "scorecard" || k === "claim" || k === "evidence") setKind(k);
    if (q.get("id")) setId(q.get("id")!);
  }, []);

  const pv = parseJson(value);
  const pe = parseJson(evValue);
  const inputError =
    (!pv.ok && `Value: ${pv.error}`) || (!pe.ok && `Evidence value: ${pe.error}`) ||
    (salt.trim() && !isSalt(salt) && "Salt must be 0x + 64 hex characters") ||
    (evSalt.trim() && !isSalt(evSalt) && "Evidence salt must be 0x + 64 hex characters") || null;

  const verify = useAction(
    (req: Schemas["VerifyRequest"], key) => unwrap(api.POST("/v1/verify", { body: req, ...idem(key) })),
  );

  function run() {
    if (inputError || !id.trim()) return;
    const reveal: NonNullable<Schemas["VerifyRequest"]["reveal"]> = {};
    if (pv.ok && pv.value) reveal.value = pv.value;
    if (salt.trim()) reveal.salt = salt.trim();
    if (pe.ok && pe.value) reveal.evidence_value = pe.value;
    if (evSalt.trim()) reveal.evidence_salt = evSalt.trim();
    verify.mutate({ kind, id: id.trim(), ...(Object.keys(reveal).length ? { reveal } : {}) });
  }

  const local = localCommit(value, salt);
  const localEv = localCommit(evValue, evSalt);
  const r = verify.data;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageTitle title="Verify a record" sub="Anyone can check a Proofwork record without an account. Paste what you were shown; nothing you paste is stored." />

      <Card>
        <form className="flex flex-col gap-4 text-sm" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1">
              <span className="font-medium">Record type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="rounded-md border border-line bg-surface px-3 py-2">
                <option value="scorecard">Scorecard</option>
                <option value="claim">Claim</option>
                <option value="evidence">Evidence item</option>
              </select>
            </label>
            <label className="flex min-w-64 flex-1 flex-col gap-1">
              <span className="font-medium">Record id</span>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="scd_… / clm_… / evd_…" className="rounded-md border border-line px-3 py-2 font-mono" />
            </label>
          </div>

          <details className="rounded-[10px] border border-line px-3.5 py-3" open={!!value || !!salt}>
            <summary className="cursor-pointer font-medium">Optional: the value and salt you were shown (selective disclosure)</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span>{kind === "claim" ? "Claim JSON" : kind === "scorecard" ? "Scorecard JSON" : "Evidence JSON"}</span>
                <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={6} className="rounded-md border border-line px-2 py-1.5 font-mono text-xs" />
              </label>
              <label className="flex flex-col gap-1">
                <span>Salt</span>
                <input value={salt} onChange={(e) => setSalt(e.target.value)} placeholder="0x…" className="rounded-md border border-line px-2 py-1.5 font-mono text-xs" />
                {local ? <span className="text-xs text-muted">Recomputed here, in your browser: <HashPill value={local} /></span> : null}
              </label>
              {kind === "claim" ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span>Evidence JSON (e.g. {"{\"excerpt\": \"…\"}"})</span>
                    <textarea value={evValue} onChange={(e) => setEvValue(e.target.value)} rows={3} className="rounded-md border border-line px-2 py-1.5 font-mono text-xs" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Evidence salt</span>
                    <input value={evSalt} onChange={(e) => setEvSalt(e.target.value)} placeholder="0x…" className="rounded-md border border-line px-2 py-1.5 font-mono text-xs" />
                    {localEv ? <span className="text-xs text-muted">Recomputed here: <HashPill value={localEv} /></span> : null}
                  </label>
                </>
              ) : null}
            </div>
          </details>

          {inputError ? <p className="text-danger">{inputError}</p> : null}
          <div>
            <Button type="submit" disabled={!id.trim() || !!inputError || verify.isPending}>{verify.isPending ? "Checking…" : "Verify"}</Button>
          </div>
          <ErrorNote error={verify.error} />
        </form>
      </Card>

      {r ? (
        <Card
          title={r.ok ? "Matches the record" : "Does not fully match"}
          right={<span className={`rounded-full px-2.5 py-1 text-sm font-semibold ${r.ok ? "bg-chain/15 text-chain" : "bg-danger/15 text-danger"}`}>{r.ok ? "✓ verified" : "✗ see below"}</span>}
        >
          <ul className="flex flex-col gap-2 text-sm">
            {r.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2">
                <span aria-hidden className={c.ok ? "text-chain" : "text-danger"}>{c.ok ? "✓" : "✗"}</span>
                <span>
                  {CHECK_TEXT[c.name] ?? c.name}
                  {c.detail ? <span className="block text-xs text-muted">{c.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <aside className="rounded-md border border-line bg-paper px-4 py-3 text-sm text-muted">
        <b className="text-ink">Honest limits.</b> A hash proves what was signed, not what the text said, if the original data is lost. Proofwork keeps an
        org database copy and an encrypted 0G replica. When a record is erased on request, its proof stays valid but the content cannot be recomputed.
      </aside>
    </div>
  );
}
