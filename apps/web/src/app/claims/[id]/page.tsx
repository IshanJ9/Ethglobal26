"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { usePublicConfig } from "@/lib/config";
import { useClaim, useCycles } from "@/lib/queries";
import { InferenceTrace } from "@/components/InferenceTrace";
import { SigningPanel } from "@/components/SigningPanel";
import { ActorTag, Button, Card, ErrorNote, HashPill, Loading, PageTitle, StatusChip, TextLink } from "@/components/ui";

const STEPS: { state: Schemas["ClaimState"]; label: string }[] = [
  { state: "drafted", label: "Drafted by AI" },
  { state: "pending_cosign", label: "Signed by you" },
  { state: "verified", label: "Co-signed, verified" },
];

function Timeline({ state }: { state: Schemas["ClaimState"] }) {
  const terminalBad = ["declined", "expired", "rejected", "disputed"].includes(state);
  const idx = terminalBad ? 1 : Math.max(0, STEPS.findIndex((s) => s.state === state || (state === "submitted" && s.state === "pending_cosign")));
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm">
      {STEPS.map((s, i) => (
        <li key={s.state} className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 ${i <= idx ? "bg-ink text-surface" : "border border-line text-muted"}`}>{s.label}</span>
          {i < STEPS.length - 1 ? <span aria-hidden className="text-muted">→</span> : null}
        </li>
      ))}
      {terminalBad ? <StatusChip status={state} /> : null}
    </ol>
  );
}

function GrantPanel({ claim }: { claim: Schemas["Claim"] }) {
  const { data: cfg } = usePublicConfig();
  const [method, setMethod] = useState<Schemas["CosignAuthMethod"]>("magic_link_wallet");
  const [grant, setGrant] = useState<Schemas["CosignGrant"] | null>(null);
  const create = useAction(
    (m: Schemas["CosignAuthMethod"], key) =>
      unwrap(api.POST("/v1/claims/{claim_id}/cosign-grants", { params: { path: { claim_id: claim.claim_id } }, body: { auth_method: m, ttl_hours: 72 }, ...idem(key) })),
    { onSuccess: setGrant },
  );
  const link = grant ? `${window.location.origin}${grant.url}` : "";

  if (grant) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p>
          Send this link to {claim.cosigner_label}. It works once and expires {new Date(grant.expires_at).toLocaleString()}. It is shown only now.
        </p>
        <div className="flex items-center gap-2">
          <input readOnly value={link} className="w-full rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button kind="secondary" onClick={() => navigator.clipboard?.writeText(link)}>Copy</Button>
        </div>
        <TextLink href={grant.url}>Open as the co-signer (demo)</TextLink>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted">Invite {claim.cosigner_label} to confirm this claim. They see only this claim, nothing else.</p>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={method === "magic_link_wallet"} onChange={() => setMethod("magic_link_wallet")} /> Link + wallet signature
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={method === "world_id"} onChange={() => setMethod("world_id")} /> Link + World ID (proof of human)
          {cfg?.world_mode === "mock" ? <span className="hatch-mock rounded-sm px-1 text-[10px] font-semibold">Mock</span> : null}
        </label>
      </div>
      <div>
        <Button onClick={() => create.mutate(method)} disabled={create.isPending}>{create.isPending ? "Creating…" : "Create co-sign link"}</Button>
      </div>
      <ErrorNote error={create.error} />
    </div>
  );
}

export default function ClaimPage() {
  const { id } = useParams<{ id: string }>();
  const me = useRequireSession();
  const qc = useQueryClient();
  const claim = useClaim(id);
  const cycles = useCycles();
  useSignOutOnUnauthorized(claim.error, cycles.error);
  if (!me) return null;
  if (claim.isLoading) return <Loading what="Loading claim" />;
  if (!claim.data) return <ErrorNote error={claim.error ?? new Error("Claim not found")} />;

  const c = claim.data;
  const mine = c.employee_id === me.employee_id;
  const cycleNumericId = cycles.data?.items.find((x) => x.cycle_id === c.cycle_id)?.numeric_id;
  const b = c.body;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        title={b.summary || "Claim"}
        sub={<>{c.kra_id.replace(/_/g, " ")} · co-signer {c.cosigner_label}</>}
        right={<Button kind="secondary" onClick={() => qc.invalidateQueries({ queryKey: ["claim", id] })}>Refresh</Button>}
      />
      <Timeline state={c.state} />

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card title="The claim" right={<ActorTag actor={c.state === "verified" ? "human" : "ai"} label={c.state === "verified" ? "co-signed" : "AI-drafted, unverified"} />}>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Kind</dt><dd>{b.kind.replace(/_/g, " ")}</dd>
            <dt className="text-muted">Summary</dt><dd>{b.summary}</dd>
            <dt className="text-muted">Date</dt><dd>{b.occurred_on}</dd>
            <dt className="text-muted">Duration</dt><dd>{b.duration_minutes} min</dd>
            <dt className="text-muted">Counterparty</dt><dd>{b.counterparty_label}</dd>
            <dt className="text-muted">Excerpt</dt><dd className="italic">“{c.evidence_excerpt}”</dd>
            <dt className="text-muted">Co-signer wallet</dt><dd><HashPill value={c.cosigner_address} /></dd>
            {c.claim_commitment ? (<><dt className="text-muted">Claim commitment</dt><dd><HashPill value={c.claim_commitment} /></dd></>) : null}
            {c.employee_signature ? (<><dt className="text-muted">Your signature</dt><dd><HashPill value={c.employee_signature} /></dd></>) : null}
            {c.cosigner_signature ? (<><dt className="text-muted">Co-signature</dt><dd><HashPill value={c.cosigner_signature} /></dd></>) : null}
            {c.decline_reason ? (<><dt className="text-muted">Declined because</dt><dd className="text-danger">{c.decline_reason}</dd></>) : null}
          </dl>
        </Card>
        <InferenceTrace inference={c.inference} flags={c.ai_flags} />
      </div>

      {mine && c.state === "drafted" ? (
        <Card title="Verify it yourself, then sign">
          <SigningPanel claim={c} persona={me} cycleNumericId={cycleNumericId} />
        </Card>
      ) : null}
      {mine && c.state === "pending_cosign" ? (
        <Card title="Ask for a co-signature">
          <GrantPanel claim={c} />
        </Card>
      ) : null}
      {c.state === "verified" ? (
        <Card title="Verified">
          <p className="text-sm">Both signatures are recorded. This claim now counts as evidence{c.evidence_id ? <> (<span className="font-mono">{c.evidence_id}</span>)</> : null}.</p>
        </Card>
      ) : null}
    </div>
  );
}
