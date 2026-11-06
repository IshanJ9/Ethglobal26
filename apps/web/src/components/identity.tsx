"use client";

import type { Schemas } from "@/lib/api";
import { usePublicConfig } from "@/lib/config";
import { useEnsText, useVerifiedEnsName } from "@/lib/ens";
import { HashPill } from "./ui";

/**
 * A person as the app shows them: ENS handle when it resolves (or the API already knows it), else the display name.
 * Identity is real, not decorative: the ENS name is resolved from chain, never typed in.
 */
export function PersonName({ name, address, ens }: { name: string; address?: string | null; ens?: string | null }) {
  const resolved = useVerifiedEnsName(address ?? undefined, ens);
  const handle = resolved.data ?? null;
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="font-medium">{name}</span>
      <span className="text-xs text-muted">
        {handle ? <span className="font-mono">{handle}</span> : address ? <HashPill value={address} /> : null}
      </span>
    </span>
  );
}

/** An address with its ENS name in front when it has one (payee, co-signer, ...). */
export function EnsAddress({ address }: { address: string }) {
  const name = useVerifiedEnsName(address);
  return (
    <span className="inline-flex items-center gap-1">
      {name.data ? <span className="font-mono text-xs font-semibold">{name.data}</span> : null}
      <HashPill value={address} />
    </span>
  );
}

type AgentIdentity = NonNullable<Schemas["Run"]["agent_identity"]>;

/** The evidence agent's identity on every run trace: ENS name, its address, Agent Pass status and ENS text records. */
export function AgentBadge({ identity }: { identity?: AgentIdentity }) {
  const { data: cfg } = usePublicConfig();
  const parent = cfg?.ens?.parent_name;
  const base = identity?.ens_name ?? cfg?.agent.ens_name ?? "agent";
  const full = parent && !base.includes(".") ? `${base}.${parent}` : base;
  const role = useEnsText(full.includes(".") ? full : undefined, "role");
  const policy = useEnsText(full.includes(".") ? full : undefined, "policy");
  const pass = identity?.agent_pass ?? "unverified";
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      <span className="rounded-full bg-ai/15 px-2 py-0.5 font-mono text-xs font-semibold text-ai">{full}</span>
      {identity?.address && identity.address !== "0x0000000000000000000000000000000000000000" ? <HashPill value={identity.address} /> : null}
      <span className={`text-xs ${pass === "verified" ? "text-chain" : "text-muted"}`}>
        Agent Pass: {pass}
      </span>
      {role.data ? <span className="text-xs text-muted">role={role.data}</span> : null}
      {policy.data ? <span className="text-xs text-muted">policy=<HashPill value={policy.data} /></span> : null}
      {!full.includes(".") || cfg?.ens?.network === "none" || !cfg?.ens?.network ? <span className="text-xs text-muted">(ENS not resolved)</span> : null}
    </span>
  );
}
