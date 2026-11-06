import { NextResponse } from "next/server";
import { signRequest } from "@worldcoin/idkit-core/signing";

/**
 * World ID 4.0 RP context (CR-002 workaround on the web's own server).
 * IDKit requires a request signed by the relying party's key, and World says never to sign on the client.
 * This route runs on the Next.js server only; WORLD_RP_SIGNING_KEY has no NEXT_PUBLIC_ prefix, so it is never
 * bundled for the browser. It signs only Proofwork's two actions, for a short time. When the API starts serving
 * `world_rp_context` (CR-002), the web uses that instead and this route goes unused.
 */
// One World action per decided object ("<base>-<object id>"): World ID 4.0 nullifiers are single-use per action.
const ACTION_RE = /^(pw-approve-scorecard|pw-cosign-claim|pw-anchor-review|pw-ack-review)(-[A-Za-z0-9_]{3,64})?$/;
const ACTIONS = { has: (a: string) => ACTION_RE.test(a) };
const TTL_SECONDS = 300;

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = process.env.WORLD_RP_SIGNING_KEY;
  const rpId = process.env.WORLD_RP_ID;
  if (!key || !rpId) {
    return NextResponse.json({ code: "world_not_configured", message: "WORLD_RP_ID / WORLD_RP_SIGNING_KEY are not set on the web server" }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) return NextResponse.json({ code: "bad_action", message: "unknown World action" }, { status: 400 });
  try {
    const s = signRequest({ signingKeyHex: key, action, ttl: TTL_SECONDS });
    return NextResponse.json(
      { rp_id: rpId, nonce: s.nonce, created_at: s.createdAt, expires_at: s.expiresAt, signature: s.sig },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    // Never echo the key or the library error (it may include key material).
    return NextResponse.json({ code: "sign_failed", message: "could not sign the World request; check WORLD_RP_SIGNING_KEY" }, { status: 500 });
  }
}
