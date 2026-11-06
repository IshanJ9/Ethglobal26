import type { Schemas } from "./api";

export type WorldResult = Schemas["WorldResult"];

/** World ID 4.0 RP context, as IDKit wants it (signed by the relying party on a server). */
export type RpContext = { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };

export type LiveWorldRequest = { action: string; signal: string; appId: string; rpContext: RpContext };

/** Set by <WorldProvider/>, which owns the IDKit widget (QR code / World App hand-off). */
let liveHandler: ((r: LiveWorldRequest) => Promise<WorldResult>) | null = null;
export function registerLiveWorld(h: typeof liveHandler) {
  liveHandler = h;
}

/**
 * The one place the web talks to World (AGENT_B 3.1, INTEGRATION 8).
 * Every proof is bound to the action + signal the SERVER issued (Approval.world_action + challenge, or
 * CosignView.world_action + claim digest). The server decides whether it is valid; World proves a human, not a role.
 * Live: IDKit 4 proof-of-human, posted to the API unchanged as `{adapter:"idkit", payload}`.
 */
export async function requestWorldProof(
  mode: "mock" | "live",
  { action, signal, appId, rpContext }: { action: string; signal: string; appId?: string | null; rpContext?: unknown },
): Promise<WorldResult> {
  if (mode === "mock") {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const nullifier = "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return { adapter: "mock", payload: { action, signal, nullifier } };
  }
  const app = appId || process.env.NEXT_PUBLIC_WORLD_APP_ID;
  if (!app || !app.startsWith("app_")) throw new Error("World is in live mode but no World app id is configured (WORLD_APP_ID on the API).");
  if (!liveHandler) throw new Error("World widget is not mounted.");
  const ctx = isRpContext(rpContext) ? rpContext : await fetchRpContext(action);
  return liveHandler({ action, signal, appId: app, rpContext: ctx });
}

function isRpContext(x: unknown): x is RpContext {
  const r = x as RpContext | null;
  return !!r && typeof r.rp_id === "string" && typeof r.signature === "string" && typeof r.nonce === "string";
}

/** Server-signed context from this web app's own server route (CR-002 workaround). */
async function fetchRpContext(action: string): Promise<RpContext> {
  const res = await fetch("/api/world/rp-context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `World request signing failed (${res.status})`);
  return body as RpContext;
}
