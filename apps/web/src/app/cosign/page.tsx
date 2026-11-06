"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAddress, type Hex } from "viem";
import { claimDigest, makeDomain, recoverClaimSigner, toClaimMessage } from "@proofwork/crypto";
import { api, ApiError, unwrap } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { usePublicConfig } from "@/lib/config";
import { PERSONAS } from "@/lib/personas";
import { requestWorldProof } from "@/lib/world";
import { demoAccount, hasInjectedWallet, signWithDemoKey, signWithInjected } from "@/lib/wallet";
import { AiFlags } from "@/components/InferenceTrace";
import { ModeBadge } from "@/components/ModeBadge";
import { Button, Card, ErrorNote, HashPill, Loading } from "@/components/ui";

const tokenHeaders = (token: string) => ({ headers: { "X-Cosign-Token": token } });

function useCountdown(until: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!until) return "";
  const s = Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return s === 0 ? "expired" : `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}

function Closed({ message }: { message: string }) {
  return (
    <div className="mx-auto mt-10 max-w-lg rounded-lg border border-line bg-surface p-8 text-center">
      <h1 className="font-display text-2xl font-semibold">Access closed</h1>
      <p className="mt-2 text-muted">{message}</p>
    </div>
  );
}

/** Sign with the persona whose wallet the claim names (demo), so the demo cannot pick a wrong key. */
function cosignerPersona(address: string) {
  return PERSONAS.find((p) => p.wallet_address.toLowerCase() === address.toLowerCase());
}

export default function CosignPage() {
  const { data: cfg } = usePublicConfig();
  const [token, setToken] = useState<string | null>(null);
  const [done, setDone] = useState<"signed" | "declined" | null>(null);
  const [wallet, setWallet] = useState<"demo" | "injected">("demo");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    const m = window.location.hash.match(/token=([^&]+)/);
    setToken(m ? decodeURIComponent(m[1]) : "");
  }, []);

  const view = useQuery({
    queryKey: ["cosign-view", token],
    queryFn: () => unwrap(api.GET("/v1/cosign/view", tokenHeaders(token!))),
    enabled: !!token && !done,
    retry: false,
  });
  const v = view.data;
  const countdown = useCountdown(v?.expires_at);

  const derived = useMemo(() => {
    if (!v) return null;
    const domain = makeDomain(v.typed_data.domain.chainId, getAddress(v.typed_data.domain.verifyingContract));
    const message = toClaimMessage(v.typed_data.message);
    return { domain, message, digest: claimDigest(domain, message) };
  }, [v]);

  // The co-signer checks the employee really signed this exact claim before adding their own signature.
  const employeeSig = useQuery({
    queryKey: ["cosign-emp-sig", derived?.digest, v?.employee_signature],
    queryFn: async () => {
      const signer = await recoverClaimSigner(derived!.domain, derived!.message, v!.employee_signature as Hex);
      return signer === derived!.message.employee;
    },
    enabled: !!derived && !!v?.employee_signature,
  });

  const sign = useAction(
    async (_: string, key) => {
      if (!v || !derived) throw new Error("Nothing to sign");
      let signature: Hex;
      if (wallet === "demo") {
        const p = cosignerPersona(v.typed_data.message.cosigner);
        if (!p) throw new Error("No demo key for this co-signer address");
        signature = await signWithDemoKey(p.persona_id, v.typed_data);
      } else {
        signature = (await signWithInjected(v.typed_data)).signature;
      }
      const world_result =
        v.auth_method === "world_id" && cfg
          ? await requestWorldProof(cfg.world_mode, {
              action: v.world_action ?? "pw-cosign-claim",
              signal: derived.digest,
              appId: cfg.world_app_id,
              rpContext: (v as { world_rp_context?: unknown }).world_rp_context, // CR-002, when the API serves it
            })
          : undefined;
      return unwrap(api.POST("/v1/cosign/sign", { body: { signature, world_result }, headers: { "X-Cosign-Token": token!, ...idem(key).headers } }));
    },
    { onSuccess: () => setDone("signed") },
  );

  const decline = useAction(
    (r: string, key) => unwrap(api.POST("/v1/cosign/decline", { body: { reason: r }, headers: { "X-Cosign-Token": token!, ...idem(key).headers } })),
    { onSuccess: () => setDone("declined") },
  );

  if (token === null) return <Loading />;
  if (token === "") return <Closed message="This page needs the link you were sent. The link is incomplete." />;
  if (done === "signed") return <Closed message="Thank you. Your co-signature is recorded and this link no longer works." />;
  if (done === "declined") return <Closed message="You declined this claim. The employee has been told, and this link no longer works." />;
  if (view.error instanceof ApiError && (view.error.code === "grant_closed" || view.error.status === 410)) {
    return <Closed message="This link is no longer active. It was already used, declined or has expired." />;
  }
  if (view.isLoading) return <Loading what="Opening the claim" />;
  if (!v) return <ErrorNote error={view.error} />;

  const dev = cfg?.auth_mode === "dev";
  const demoP = cosignerPersona(v.typed_data.message.cosigner);
  const worldMode = cfg?.world_mode ?? "mock";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div>
        <p className="text-sm text-muted">Link expires in <span className="font-semibold tabular-nums text-ink">{countdown}</span></p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">{v.requester_display_name} asks you to confirm</h1>
        <p className="mt-1 text-muted">You see only this claim. Signing confirms it happened as described; nothing else is shared with you.</p>
      </div>

      <Card>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">What</dt><dd className="font-medium">{v.body.summary}</dd>
          <dt className="text-muted">Kind</dt><dd>{v.body.kind.replace(/_/g, " ")}</dd>
          <dt className="text-muted">Date</dt><dd>{v.body.occurred_on}</dd>
          <dt className="text-muted">Duration</dt><dd>{v.body.duration_minutes} min</dd>
          <dt className="text-muted">With</dt><dd>{v.body.counterparty_label}</dd>
          <dt className="text-muted">Their words</dt><dd className="italic">“{v.evidence_excerpt}”</dd>
          <dt className="text-muted">Employee signature</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <HashPill value={v.employee_signature} />
            {employeeSig.data === true ? <span className="text-xs text-chain">✓ verified against this claim</span> : null}
            {employeeSig.data === false ? <span className="text-xs text-danger">✗ does not match this claim</span> : null}
          </dd>
          <dt className="text-muted">Claim digest</dt><dd><HashPill value={derived?.digest} head={10} tail={8} /></dd>
        </dl>
      </Card>

      <AiFlags flags={v.ai_flags} />

      <Card>
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-wrap items-center gap-4 text-sm">
            <legend className="mb-1 font-medium">Sign with</legend>
            {dev && demoP ? (
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={wallet === "demo"} onChange={() => setWallet("demo")} />
                Demo key for {demoP.display_name} ({demoAccount(demoP.persona_id).address.slice(0, 8)}…)
                <span className="rounded bg-mock/40 px-1 text-[10px] font-bold">DEMO KEYS</span>
              </label>
            ) : null}
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={wallet === "injected" || !dev} onChange={() => setWallet("injected")} disabled={!hasInjectedWallet()} />
              Browser wallet{hasInjectedWallet() ? "" : " (none found)"}
            </label>
          </fieldset>
          {v.auth_method === "world_id" ? (
            <p className="flex items-center gap-2 text-sm">
              This link also asks you to prove you are a unique human with World ID. <ModeBadge mode={worldMode} />
            </p>
          ) : null}

          {!declining ? (
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => sign.mutate("sign")} disabled={sign.isPending || employeeSig.data === false}>
                {sign.isPending ? "Signing…" : v.auth_method === "world_id" ? (worldMode === "mock" ? "Mock World verification and sign" : "Verify with World ID and sign") : "Sign to confirm"}
              </Button>
              <Button kind="danger" onClick={() => setDeclining(true)}>Decline</Button>
            </div>
          ) : (
            <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) decline.mutate(reason.trim()); }}>
              <label className="text-sm font-medium" htmlFor="reason">Why are you declining?</label>
              <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} className="rounded-md border border-line px-3 py-2 text-sm" />
              <div className="flex gap-3">
                <Button kind="danger" type="submit" disabled={!reason.trim() || decline.isPending}>{decline.isPending ? "Declining…" : "Decline claim"}</Button>
                <Button kind="secondary" onClick={() => setDeclining(false)}>Back</Button>
              </div>
            </form>
          )}
          <ErrorNote error={sign.error ?? decline.error} />
        </div>
      </Card>
    </div>
  );
}

