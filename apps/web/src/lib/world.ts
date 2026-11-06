import type { Schemas } from "./api";

export type WorldResult = Schemas["WorldResult"];

/**
 * The one place the web talks to World (AGENT_B 3.1, INTEGRATION 8).
 * Every proof is bound to the action + signal the SERVER issued (Approval.world_action + challenge, or
 * CosignView.world_action + claim digest). The server decides whether it is valid; World proves a human, not a role.
 */
export async function requestWorldProof(
  mode: "mock" | "live",
  { action, signal }: { action: string; signal: string },
): Promise<WorldResult> {
  if (mode === "mock") {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const nullifier = "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return { adapter: "mock", payload: { action, signal, nullifier } };
  }
  // Live flow waits on U1 (World mentor) and CR-002 (server-signed rp_context). Fail loudly rather than fake it.
  throw new Error("Live World verification is not available in this build yet. Ask the operator to use WORLD_MODE=mock.");
}
