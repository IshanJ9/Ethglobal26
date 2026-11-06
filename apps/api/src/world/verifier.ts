// WorldVerifier: the ONLY code that interprets a WorldResult (INTEGRATION section 8).
// It checks the proof is bound to the server-issued action + signal; nullifier replay is enforced by
// the caller via the world_nullifiers table (consumeNullifier) inside the same transaction.
import { canonicalJson, keccakBytes, keccakUtf8, type Hex } from "@proofwork/crypto";
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
    return { ok: true, nullifier: normalizeNullifier(p.nullifier) };
  }
}

/**
 * Live verifier (World ID 4.0 docs, Nov 2026): POST {base}/api/v4/verify/{rp_id} with the IDKit result
 * forwarded as-is; success requires `success === true` and the expected environment. The portal checks the
 * proof only - action/signal binding and nullifier uniqueness are enforced here and by consumeNullifier.
 * adapter "agent_pass" fails closed until U1 (the Agent Pass server sequence) is confirmed.
 * NOT yet exercised against the live portal.
 */
export class LiveWorldVerifier implements WorldVerifier {
  readonly mode = "live" as const;
  constructor(
    private readonly rpId: string | undefined,
    private readonly opts: { baseUrl?: string; environment?: string; fetchImpl?: typeof fetch } = {},
  ) {}

  async verify({ action, signal, result }: { action: string; signal: string; result: WorldResult | undefined }): Promise<WorldCheck> {
    if (!result) return { ok: false, reason: "world_result missing" };
    if (result.adapter === "agent_pass") return { ok: false, reason: "Agent Pass server verification is not configured yet (U1)" };
    if (result.adapter !== "idkit") return { ok: false, reason: `adapter '${result.adapter}' is not accepted in WORLD_MODE=live` };
    if (!this.rpId) return { ok: false, reason: "WORLD_RP_ID / WORLD_APP_ID not configured" };
    const p = result.payload as Record<string, any>;
    if (p.action !== action) return { ok: false, reason: "action mismatch" };
    const expected = this.opts.environment ?? "production";
    if (p.environment && p.environment !== expected) return { ok: false, reason: `environment ${p.environment} != ${expected}` };
    const responses: any[] = Array.isArray(p.responses) ? p.responses : [];
    if (!responses.length) return { ok: false, reason: "no proof responses" };
    const allowed = signalHashes(signal);
    if (!responses.every((r) => typeof r.signal_hash === "string" && allowed.has(normHex(r.signal_hash)))) {
      return { ok: false, reason: "signal mismatch" };
    }
    const base = (this.opts.baseUrl ?? "https://developer.world.org").replace(/\/$/, "");
    let body: any;
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${base}/api/v4/verify/${encodeURIComponent(this.rpId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
        signal: AbortSignal.timeout(15_000),
      });
      body = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, reason: `portal ${res.status}: ${String(body?.code ?? "error")}` };
    } catch (e) {
      return { ok: false, reason: `portal unreachable: ${(e as Error).name}` };
    }
    if (body?.success !== true) return { ok: false, reason: String(body?.code ?? "verification failed") };
    if (body.environment && body.environment !== expected) return { ok: false, reason: `portal environment ${body.environment} != ${expected}` };
    const nullifier = body.nullifier ?? body.results?.find((r: any) => r.success)?.nullifier ?? responses[0]?.nullifier;
    if (nullifier === undefined || nullifier === null) return { ok: false, reason: "no nullifier in result" };
    return { ok: true, nullifier: normalizeNullifier(String(nullifier)) };
  }
}

const normHex = (h: string) => {
  try {
    return "0x" + BigInt(h).toString(16).padStart(64, "0");
  } catch {
    return "invalid";
  }
};

/**
 * World's hashToField: keccak256(bytes) >> 8. IDKit treats a 0x-hex signal as bytes, other strings as UTF-8;
 * both encodings of the server-issued signal are accepted (never anything else).
 */
export function signalHashes(signal: string): Set<string> {
  const field = (h: Hex) => "0x" + (BigInt(h) >> 8n).toString(16).padStart(64, "0");
  const out = new Set<string>([field(keccakUtf8(signal))]);
  if (/^0x([0-9a-fA-F]{2})*$/.test(signal)) out.add(field(keccakBytes(signal as Hex)));
  return out;
}

/** Store nullifiers in one canonical form (decimal string) so hex/decimal inputs cannot bypass replay checks. */
export function normalizeNullifier(n: string): string {
  try {
    return BigInt(n).toString(10);
  } catch {
    return n.toLowerCase();
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
