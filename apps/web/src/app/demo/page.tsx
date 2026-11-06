"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import scenario from "../../../../../spec/fixtures/seed-scenario.json";
import clusterSeed from "../../../../../spec/fixtures/seed-clusters.json";
import { api, unwrap, type Persona } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { usePublicConfig } from "@/lib/config";
import { PERSONAS, ROLE_LABEL } from "@/lib/personas";
import { setSession, useSession } from "@/lib/session";
import { Button, Card, ErrorNote, PageTitle } from "@/components/ui";

type Step = { step_id: string; description?: string };
type Scripted = { id: string; employee: string; kra_id: string; cosign_auth: string; raw_text: string; expect: Record<string, unknown> };
type Negative = { id: string; do: string; expect: Record<string, unknown> };

// s5 (CR-004) populates the peer clusters: peers, past review periods, deadline records.
const STEPS = [...(scenario.steps as Step[]), ...(clusterSeed.steps as Step[])];
const CLAIMS = scenario.scripted_claims as Scripted[];
const NEGATIVE = scenario.negative_tests as Negative[];
const QUICK = ["p_dev_a", "p_dev_b", "p_dev_c", "p_eng_mgr", "p_hr", "p_client_cfo"];
const STORE = "proofwork.demo";

type Saved = { played: Record<string, number>; neg: Record<string, "pass" | "fail"> };
function load(): Saved {
  try {
    return { played: {}, neg: {}, ...JSON.parse(localStorage.getItem(STORE) ?? "{}") };
  } catch {
    return { played: {}, neg: {} };
  }
}
function save(s: Saved) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    // storage blocked: checklist simply is not remembered
  }
}

async function devLogin(persona_id: Persona["persona_id"], key: string) {
  return unwrap(api.POST("/v1/dev/login", { body: { persona_id }, ...idem(key) }));
}

export default function DemoPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const session = useSession();
  const { data: cfg } = usePublicConfig();
  const [saved, setSaved] = useState<Saved>({ played: {}, neg: {} });
  useEffect(() => setSaved(load()), []);
  const update = (f: (s: Saved) => Saved) => setSaved((s) => { const n = f(s); save(n); return n; });

  const switchTo = useAction(
    async ({ persona_id }: { persona_id: Persona["persona_id"]; then?: string }, key) => devLogin(persona_id, key),
    {
      onSuccess: (r, v) => {
        qc.clear();
        setSession({ token: r.token, persona: r.persona });
        if (v.then) router.push(v.then);
      },
    },
  );

  // Steps are played as HR (the API requires it) without changing who the presenter is signed in as.
  const play = useAction(
    async (step_id: string, key) => {
      const hr = await devLogin("p_hr", `${key}-login`);
      return unwrap(api.POST("/v1/dev/inject", { body: { step_id }, headers: { Authorization: `Bearer ${hr.token}`, "Idempotency-Key": key } }));
    },
    {
      onSuccess: (r) => {
        update((s) => ({ ...s, played: { ...s.played, [r.step_id]: r.evidence_ids.length } }));
        qc.invalidateQueries();
      },
    },
  );

  if (cfg && cfg.auth_mode !== "dev") {
    return <PageTitle title="Demo controls" sub="Demo controls are only available when the API runs with AUTH_MODE=dev." />;
  }

  const passed = Object.values(saved.neg).filter((v) => v === "pass").length;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Demo controls" sub="Presenter tools for the recorded demo. Every number shown in the app still comes from the API." />

      <Card title="Who you are" right={session ? <span className="text-sm text-muted">Now: {session.persona.display_name}</span> : null}>
        <div className="flex flex-wrap gap-2">
          {QUICK.map((id) => {
            const p = PERSONAS.find((x) => x.persona_id === id)!;
            const active = session?.persona.persona_id === id;
            return (
              <Button key={id} kind={active ? "primary" : "secondary"} onClick={() => switchTo.mutate({ persona_id: p.persona_id })} disabled={switchTo.isPending}>
                {p.display_name.split(" (")[0]} <span className="ml-1 text-xs opacity-70">{ROLE_LABEL[p.role]}</span>
              </Button>
            );
          })}
        </div>
        <ErrorNote error={switchTo.error} className="mt-3" />
      </Card>

      <Card title="Story steps">
        <ol className="flex flex-col gap-3">
          {STEPS.map((s, i) => (
            <li key={s.step_id} className="flex flex-wrap items-start justify-between gap-3 border-b border-line/60 pb-3 last:border-0">
              <div className="max-w-2xl text-sm">
                <div className="font-medium">s{i + 1} · {s.step_id.replace(/^s\d_/, "").replace(/_/g, " ")}</div>
                <p className="text-muted">{s.description}</p>
              </div>
              <div className="flex items-center gap-2">
                {saved.played[s.step_id] !== undefined ? <span className="text-xs text-chain">✓ played ({saved.played[s.step_id]} items)</span> : null}
                <Button kind="secondary" onClick={() => play.mutate(s.step_id)} disabled={play.isPending}>Play</Button>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted">Tip: for the video, skip s2 and do the real claim, sign and co-sign flow with claim c1 below.</p>
        <ErrorNote error={play.error} className="mt-3" />
      </Card>

      <Card title="Scripted claims">
        <ul className="flex flex-col gap-4">
          {CLAIMS.map((c) => {
            const p = PERSONAS.find((x) => x.persona_id === c.employee);
            return (
              <li key={c.id} className="flex flex-col gap-2 border-b border-line/60 pb-4 text-sm last:border-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{c.id.replace(/_/g, " ")} · {p?.display_name} · co-sign by {c.cosign_auth === "world_id" ? "World ID" : "link + wallet"}</span>
                  <Button
                    kind="secondary"
                    onClick={() => switchTo.mutate({ persona_id: c.employee as Persona["persona_id"], then: `/claims/new?text=${encodeURIComponent(c.raw_text)}` })}
                  >
                    Sign in as {p?.display_name.split(" ")[0]} and draft
                  </Button>
                </div>
                <blockquote className="rounded border-l-4 border-line bg-paper px-3 py-2 italic">{c.raw_text}</blockquote>
                <span className="text-xs text-muted">Expected: {Object.entries(c.expect).filter(([k]) => k !== "note").map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(" · ")}</span>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Negative checks" right={<span className="text-sm text-muted">{passed}/{NEGATIVE.length} marked pass</span>}>
        <ul className="flex flex-col divide-y divide-line/60 text-sm">
          {NEGATIVE.map((n) => {
            const st = saved.neg[n.id];
            const set = (v: "pass" | "fail" | undefined) => update((s) => { const neg = { ...s.neg }; if (v) neg[n.id] = v; else delete neg[n.id]; return { ...s, neg }; });
            return (
              <li key={n.id} className="flex flex-wrap items-start justify-between gap-3 py-2">
                <div className="max-w-2xl">
                  <div className="font-medium">{n.id.replace(/_/g, " ")}</div>
                  <div className="text-muted">{n.do} → expect {JSON.stringify(n.expect)}</div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => set(st === "pass" ? undefined : "pass")} className={`rounded border px-2 py-1 text-xs ${st === "pass" ? "border-chain bg-chain/15 text-chain" : "border-line"}`}>pass</button>
                  <button onClick={() => set(st === "fail" ? undefined : "fail")} className={`rounded border px-2 py-1 text-xs ${st === "fail" ? "border-danger bg-danger/15 text-danger" : "border-line"}`}>fail</button>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-muted">All 18 are automated in A&apos;s API test suite; this list is for checking them live in front of judges.</p>
      </Card>
    </div>
  );
}
