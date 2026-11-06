// Informal evidence -> Proofwork claim, through the existing F1 flow:
//   createClaim (AI draft, state drafted) -> signing-package -> employee EIP-712 signature -> submit
//   (pending_cosign) -> cosign grant (magic link for the client / manager). The claim only counts toward a
//   KRA after the co-signer signs; until then the engine ignores it.
// Signing: in AUTH_MODE=dev the bot signs with the DEMO persona key (spec/vectors persona_key_rule, never
// funded), which is what the demo personas use everywhere else. In sso mode it never signs: it returns the
// web link so the employee signs with their own wallet.
import { toClaimMessage } from "@proofwork/crypto";
import { keccak256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ProofworkApi } from "./api.ts";

const CLAIMABLE = new Set(["cosign", "worklog", "manual"]);
const demoKey = (personaId: string) => privateKeyToAccount(keccak256(stringToBytes(`proofwork-demo-persona:${personaId}`)));

export interface Kra {
  kra_id: string;
  label: string;
}

export interface FilerContext {
  token: string;
  employeeId: string;
  displayName: string;
  cycleId: string;
  kras: Kra[];
}

export interface Cosigner {
  address: string;
  label: string;
}

export class ClaimFiler {
  constructor(private readonly api: ProofworkApi, private readonly opts: { webBase: string; cycleId?: string }) {}

  async context(personaId: string): Promise<FilerContext> {
    const { token, persona } = await this.api.devLogin(personaId);
    const emps = await this.api.call<{ items: any[] }>("GET", "/v1/org/employees", { token });
    const me = emps.items.find((e) => e.employee_id === persona.employee_id);
    if (!me) throw new Error(`${personaId} is not an employee with a plan`);
    const plan = await this.api.call<any>("GET", `/v1/org/plans/${me.plan_id}`, { token });
    const cycles = await this.api.call<{ items: any[] }>("GET", "/v1/cycles", { token });
    const today = new Date().toISOString().slice(0, 10);
    const open = cycles.items.filter((c) => c.status === "open");
    const cycle = this.opts.cycleId ?? (open.find((c) => c.starts_on <= today && today <= c.ends_on) ?? open[0])?.cycle_id;
    if (!cycle) throw new Error("no open cycle");
    const kras = (plan.kras ?? []).filter((k: any) => CLAIMABLE.has(k.source)).map((k: any) => ({ kra_id: k.kra_id, label: k.label }));
    return { token, employeeId: persona.employee_id, displayName: persona.display_name, cycleId: cycle, kras };
  }

  /** Creates the claim in state drafted. `text` must already be redacted. */
  async draft(ctx: FilerContext, text: string, kraId: string, cosigner: Cosigner) {
    return this.api.call<any>("POST", "/v1/claims", {
      token: ctx.token,
      idempotent: true,
      body: { cycle_id: ctx.cycleId, kra_id: kraId, raw_text: text.slice(0, 4000), cosigner_address: cosigner.address, cosigner_label: cosigner.label },
    });
  }

  /** dev: signs as the demo persona, submits, and returns the co-sign magic link. sso: returns the claim's web link. */
  async signAndRequestCosign(personaId: string, ctx: FilerContext, claimId: string, authMode: "dev" | "sso") {
    if (authMode !== "dev") return { cosignUrl: null, reviewUrl: `${this.opts.webBase}/claims/${claimId}` };
    const pkg = await this.api.call<any>("GET", `/v1/claims/${claimId}/signing-package`, { token: ctx.token });
    const signature = await demoKey(personaId).signTypedData({
      domain: pkg.typed_data.domain,
      types: pkg.typed_data.types,
      primaryType: "Claim",
      message: toClaimMessage(pkg.typed_data.message) as any,
    });
    await this.api.call("POST", `/v1/claims/${claimId}/submit`, { token: ctx.token, idempotent: true, body: { employee_signature: signature } });
    const grant = await this.api.call<any>("POST", `/v1/claims/${claimId}/cosign-grants`, { token: ctx.token, idempotent: true, body: { auth_method: "magic_link_wallet" } });
    return { cosignUrl: this.opts.webBase + grant.url, reviewUrl: null, expiresAt: grant.expires_at as string };
  }
}
