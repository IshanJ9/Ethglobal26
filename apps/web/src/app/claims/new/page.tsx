"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, unwrap } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { useRequireSession, useSignOutOnUnauthorized } from "@/lib/auth";
import { PERSONAS } from "@/lib/personas";
import { useCurrentCycle, useEmployees, usePlan } from "@/lib/queries";
import { ActorTag, Button, Card, ErrorNote, Loading, PageTitle } from "@/components/ui";
import { VoiceButton } from "@/components/VoiceButton";

const COSIGNERS = PERSONAS.filter((p) => p.role === "external_cosigner");

export default function NewClaimPage() {
  const me = useRequireSession();
  const router = useRouter();
  const { cycle, ...cycles } = useCurrentCycle();
  const employees = useEmployees();
  const self = employees.data?.items.find((e) => e.employee_id === me?.employee_id);
  const plan = usePlan(self?.plan_id);
  useSignOutOnUnauthorized(cycles.error, employees.error, plan.error);

  // Only KRAs fed by co-signed claims accept a claim; system-of-record KRAs come from the evidence agent.
  const kras = (plan.data?.kras ?? []).filter((k) => k.source === "cosign");
  const [kraId, setKraId] = useState<string>("");
  const [text, setText] = useState("");
  const [cosigner, setCosigner] = useState<string>(COSIGNERS[0]?.persona_id ?? "");
  // /demo links here with ?text= to prefill a scripted claim.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("text");
    if (t) setText(t);
  }, []);
  const chosenKra = kraId || kras[0]?.kra_id || "";
  const cs = COSIGNERS.find((c) => c.persona_id === cosigner);

  const create = useAction(
    (v: { cycle_id: string; kra_id: string; raw_text: string; cosigner_address: string; cosigner_label: string }, key) =>
      unwrap(api.POST("/v1/claims", { body: v, ...idem(key) })),
    { onSuccess: (c) => router.push(`/claims/${c.claim_id}`) },
  );

  if (!me) return null;
  const ready = !!cycle && !!chosenKra && text.trim().length >= 10 && !!cs;

  return (
    <div className="max-w-3xl">
      <PageTitle crumbs={[{ label: "My cycle", href: "/" }, { label: "Claims" }, { label: "New" }]} title="File a claim" sub="Describe work that someone outside the company can confirm. The AI drafts a structured claim; you review and sign it." />

      {plan.isLoading || cycles.isLoading || employees.isLoading ? <Loading /> : null}
      <ErrorNote error={plan.error ?? cycles.error ?? employees.error} />

      <Card>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            create.mutate({
              cycle_id: cycle!.cycle_id,
              kra_id: chosenKra,
              raw_text: text.trim(),
              cosigner_address: cs!.wallet_address,
              cosigner_label: `${cs!.display_name}`,
            });
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">KRA</span>
            <select value={chosenKra} onChange={(e) => setKraId(e.target.value)} className="rounded-md border border-line bg-surface px-3 py-2">
              {kras.map((k) => (
                <option key={k.kra_id} value={k.kra_id}>{k.label}</option>
              ))}
            </select>
            {plan.data && kras.length === 0 ? <span className="text-xs text-muted">Your plan has no KRAs that take co-signed claims.</span> : null}
          </label>

          <div className="flex flex-col gap-1 text-sm">
            <span className="flex items-center justify-between gap-2">
              <label htmlFor="claim-text" className="font-medium">What happened</label>
              <VoiceButton onText={(t) => setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t).slice(0, 4000))} />
            </span>
            <textarea
              id="claim-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              maxLength={4000}
              placeholder="On 14 Oct I had a 45 minute call with Acme Bank's CFO where we agreed to move go-live to January if the API is ready by 15 Dec."
              className="rounded-md border border-line bg-surface px-3 py-2"
            />
            <span className="text-xs text-muted">Your text is treated as data. Instructions inside it are ignored and flagged.</span>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Who will co-sign</span>
            <select value={cosigner} onChange={(e) => setCosigner(e.target.value)} className="rounded-md border border-line bg-surface px-3 py-2">
              {COSIGNERS.map((c) => (
                <option key={c.persona_id} value={c.persona_id}>{c.display_name}</option>
              ))}
            </select>
          </label>

          <div className="flex items-center justify-between gap-3">
            <ActorTag actor="ai" label="The draft is written by the AI and stays unverified until signed and co-signed" />
            <Button type="submit" disabled={!ready || create.isPending}>
              {create.isPending ? "Drafting…" : "Draft with AI"}
            </Button>
          </div>
          <ErrorNote error={create.error} />
        </form>
      </Card>
    </div>
  );
}
