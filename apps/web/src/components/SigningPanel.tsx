"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "@/lib/api";
import { idem, useAction } from "@/lib/action";
import { usePublicConfig } from "@/lib/config";
import { verifySigningPackage } from "@/lib/verifySigning";
import { hasInjectedWallet, signWithDemoKey, signWithInjected } from "@/lib/wallet";
import { Button, ErrorNote, HashPill } from "./ui";

/**
 * Anti-blind-signing: fetch the signing package, rebuild every hash locally, and only then allow a signature.
 * Fetching the package freezes the draft (server rule), so it happens on an explicit click.
 */
export function SigningPanel({
  claim, persona, cycleNumericId,
}: { claim: Schemas["Claim"]; persona: Schemas["Persona"]; cycleNumericId: number | undefined }) {
  const qc = useQueryClient();
  const { data: cfg } = usePublicConfig();
  const [pkg, setPkg] = useState<Schemas["SigningPackage"] | null>(null);
  const [tamper, setTamper] = useState(false);
  const [wallet, setWallet] = useState<"demo" | "injected">("demo");
  const dev = cfg?.auth_mode === "dev";

  const load = useAction(
    () => unwrap(api.GET("/v1/claims/{claim_id}/signing-package", { params: { path: { claim_id: claim.claim_id } } })),
    { onSuccess: (p) => setPkg(p) },
  );

  // Demo of the guarantee: pretend the server swapped one word in what you would sign.
  const shown = useMemo(() => {
    if (!pkg || !tamper) return pkg;
    return { ...pkg, claim_value: { ...pkg.claim_value, summary: pkg.claim_value.summary.replace(/\b(\w+)\b/, "$1 (edited)") } };
  }, [pkg, tamper]);

  const checks = useMemo(
    () => (shown && cfg ? verifySigningPackage({ pkg: shown, claim, config: cfg, signerAddress: persona.wallet_address, cycleNumericId }) : []),
    [shown, cfg, claim, persona.wallet_address, cycleNumericId],
  );
  const allOk = checks.length > 0 && checks.every((c) => c.ok);

  const submit = useAction(
    async (_: string, key) => {
      if (!pkg) throw new Error("No signing package");
      const signature =
        wallet === "demo" ? await signWithDemoKey(persona.persona_id, pkg.typed_data) : (await signWithInjected(pkg.typed_data)).signature;
      return unwrap(api.POST("/v1/claims/{claim_id}/submit", { params: { path: { claim_id: claim.claim_id } }, body: { employee_signature: signature }, ...idem(key) }));
    },
    { onSuccess: () => qc.invalidateQueries({ queryKey: ["claim", claim.claim_id] }) },
  );

  if (!pkg) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Before you sign, this page rebuilds every hash from the plain text and checks it against what the server asks you to sign. Preparing the
          signature freezes the draft.
        </p>
        <div>
          <Button onClick={() => load.mutate(claim.claim_id)} disabled={load.isPending}>
            {load.isPending ? "Preparing…" : "Review and sign"}
          </Button>
        </div>
        <ErrorNote error={load.error} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!allOk ? (
        <div role="alert" className="rounded-md border-2 border-danger bg-danger/10 px-3 py-2 font-semibold text-danger">
          Server data does not match what you are signing. Signing is disabled.
        </div>
      ) : null}

      <ul className="flex flex-col gap-1.5 text-sm">
        {checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2">
            <span aria-hidden className={c.ok ? "text-chain" : "text-danger"}>{c.ok ? "✓" : "✗"}</span>
            <span>
              <span className={c.ok ? "" : "font-semibold text-danger"}>{c.label}</span>
              {!c.ok && c.detail ? <span className="block break-all font-mono text-xs text-muted">{c.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>Digest <HashPill value={pkg.digest} head={10} tail={8} /></span>
        <span>Domain {pkg.typed_data.domain.name} v{pkg.typed_data.domain.version}, chain {pkg.typed_data.domain.chainId}</span>
      </div>

      <fieldset className="flex flex-wrap items-center gap-4 text-sm">
        <legend className="sr-only">Wallet</legend>
        {dev ? (
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={wallet === "demo"} onChange={() => setWallet("demo")} />
            Demo key for {persona.display_name} <span className="rounded bg-mock/40 px-1 text-[10px] font-bold">DEMO KEYS</span>
          </label>
        ) : null}
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={wallet === "injected" || !dev} onChange={() => setWallet("injected")} disabled={!hasInjectedWallet()} />
          Browser wallet{hasInjectedWallet() ? "" : " (none found)"}
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => submit.mutate(claim.claim_id)} disabled={!allOk || submit.isPending || (!dev && !hasInjectedWallet())}>
          {submit.isPending ? "Signing…" : "Sign and submit"}
        </Button>
        {dev ? (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
            Demo: simulate the server changing the text
          </label>
        ) : null}
      </div>
      <ErrorNote error={submit.error} />
    </div>
  );
}
