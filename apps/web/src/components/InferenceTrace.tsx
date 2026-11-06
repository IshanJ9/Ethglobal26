import type { Schemas } from "@/lib/api";
import { ModeBadge } from "./ModeBadge";
import { HashPill } from "./ui";

type Flag = NonNullable<Schemas["Claim"]["ai_flags"]>[number];

const FLAG_TEXT: Record<Flag, string> = {
  prompt_injection_suspected:
    "The text contained instructions aimed at the AI. They were ignored: they cannot change the claim's state, score or approval.",
  low_confidence: "The AI was unsure about some fields. Check them before signing.",
  fields_inferred: "Some fields were inferred rather than stated. Check them before signing.",
};

export function AiFlags({ flags }: { flags?: Flag[] }) {
  if (!flags?.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {flags.map((f) => (
        <li key={f} className="rounded-md border border-human/40 bg-human/10 px-3 py-2 text-sm text-human">
          <span className="font-semibold">{f.replace(/_/g, " ")}</span>: {FLAG_TEXT[f]}
        </li>
      ))}
    </ul>
  );
}

/** Who drafted it and whether that run is provable (AGENT_B 4.2 InferenceTrace). */
export function InferenceTrace({ inference, flags }: { inference?: Schemas["InferenceRecord"]; flags?: Flag[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-ai/30 bg-ai/5 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ai">AI draft trace</span>
        {inference ? <ModeBadge mode={inference.mode} /> : null}
      </div>
      {inference ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">Provider</dt>
          <dd>{inference.provider === "0g_private_computer" ? "0G Private Computer" : "Mock drafter"}</dd>
          <dt className="text-muted">Model</dt>
          <dd className="font-mono text-xs">{inference.model}</dd>
          <dt className="text-muted">Request</dt>
          <dd><HashPill value={inference.request_id} head={10} tail={6} /></dd>
          <dt className="text-muted">TEE attestation</dt>
          <dd>
            {inference.tee_verified === true ? (
              <span className="text-chain">verified</span>
            ) : inference.tee_verified === false ? (
              <span className="text-danger">failed</span>
            ) : (
              <span className="text-muted">not available{inference.mode === "mock" ? " (mock)" : ""}</span>
            )}
          </dd>
          <dt className="text-muted">Prompt hash</dt>
          <dd><HashPill value={inference.prompt_hash} /></dd>
          <dt className="text-muted">Output hash</dt>
          <dd><HashPill value={inference.output_hash} /></dd>
        </dl>
      ) : (
        <p className="text-muted">No inference record.</p>
      )}
      <AiFlags flags={flags} />
    </div>
  );
}
