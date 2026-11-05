"use client";

import { usePublicConfig } from "@/lib/config";
import { ModeBadge } from "./ModeBadge";

type Actor = "ai" | "code" | "human" | "chain";

const ACCENT: Record<Actor, string> = {
  ai: "border-ai text-ai",
  code: "border-code text-code",
  human: "border-human text-human",
  chain: "border-chain text-chain",
};

/**
 * The product rule as the page's spine: who did each step, and whether that step is real.
 * The same four actor colours tag evidence, traces and timelines everywhere else.
 */
export function ProvenanceStrip() {
  const { data: cfg, isError } = usePublicConfig();
  const unknown = !cfg;

  const steps: { actor: Actor; verb: string; who: string; mode?: "mock" | "live" }[] = [
    { actor: "ai", verb: "Agents collect", who: "0G Private Computer", mode: cfg?.zerog_mode },
    { actor: "code", verb: "Code computes", who: "Deterministic engine" },
    { actor: "human", verb: "Humans decide", who: "World step-up", mode: cfg?.world_mode },
    { actor: "chain", verb: "Chain proves", who: cfg ? cfg.chain.name : "Arc", mode: cfg?.chain_mode },
  ];

  return (
    <ol
      aria-label="How Proofwork reaches a decision"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line md:grid-cols-4"
    >
      {steps.map((s) => (
        <li key={s.actor} className={`border-t-[3px] bg-surface px-3 py-2 ${ACCENT[s.actor]}`}>
          <div className="font-display text-[15px] font-semibold leading-tight">{s.verb}</div>
          <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted">
            <span className="truncate">{s.who}</span>
            {s.mode ? (
              <ModeBadge mode={s.mode} />
            ) : s.actor === "code" ? (
              <span className="text-[11px]">no AI</span>
            ) : unknown ? (
              <span className="text-[11px]">{isError ? "unknown" : "…"}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
