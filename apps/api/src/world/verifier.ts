// WorldVerifier: the ONLY code that interprets a WorldResult (INTEGRATION section 8).
// It checks the proof is bound to the server-issued action + signal; nullifier replay is enforced by
// the caller via the world_nullifiers table (consumeNullifier) inside the same transaction.
import { canonicalJson, keccakUtf8, type Hex } from "@proofwork/crypto";
import type { components } from "@proofwork/shared";
import type { DB } from "../db/index.ts";

export type WorldResult = components["schemas"]["WorldResult"];
export type WorldCheck = { ok: true; nullifier: string } | { ok: false; reason: string };

export interface WorldVerifier {
  readonly mode: "mock" | "live";
  verify(args: { action: string; signal: string; result: WorldResult | undefined }): Promise<WorldCheck>;
}

export class MockWorldVerifier implements WorldVerifier {
  readonly mode = "mock" as const;
  async verify({ action, signal, result }: { action: string; signal: string; result: WorldResult | undefined }): Promise<WorldCheck> {
    if (!result) return { ok: false, reason: "world_result missing" };
    if (result.adapter !== "mock") return { ok: false, reason: "WORLD_MODE=mock accepts adapter 'mock' only" };
    const p = result.payload as Record<string, unknown>;
    if (p.action !== action) return { ok: false, reason: "action mismatch" };
    if (typeof p.signal !== "string" || p.signal.toLowerCase() !== signal.toLowerCase()) return { ok: false, reason: "signal mismatch" };
    if (typeof p.nullifier !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(p.nullifier)) return { ok: false, reason: "bad nullifier" };
    return { ok: true, nullifier: p.nullifier.toLowerCase() };
  }
}

/** Placeholder until U1 (Agent Pass server-verify sequence) is resolved; fails closed. */
export class LiveWorldVerifier implements WorldVerifier {
  readonly mode = "live" as const;
  async verify(): Promise<WorldCheck> {
    return { ok: false, reason: "live World verification is not configured yet (U1)" };
  }
}

/** Records a nullifier; false if it was already used (replay). Call inside a transaction. */
export function consumeNullifier(db: DB, nullifier: string, context: string, at: string): boolean {
  const r = db.prepare("INSERT OR IGNORE INTO world_nullifiers (nullifier, context, used_at) VALUES (?, ?, ?)").run(nullifier, context, at);
  return r.changes === 1;
}

/** Only the hash of a World result is ever stored. */
export function worldResultHash(result: WorldResult): Hex {
  try {
    return keccakUtf8(canonicalJson(result));
  } catch {
    // Non-canonical payloads (e.g. floats from an SDK) still get a stable hash of their JSON text.
    return keccakUtf8(JSON.stringify(result));
  }
}
