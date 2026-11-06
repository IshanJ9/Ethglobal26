// Idempotency-Key (INTEGRATION 5.8): a repeated POST with the same key, caller and path returns the first
// response instead of acting twice (double clicks on "release", "attest", ...). The same key with a different
// body is a 409 conflict. Only successful (2xx) responses are remembered.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { canonicalJson } from "@proofwork/crypto";
import type { DB } from "../db/index.ts";
import { errors } from "../errors.ts";
import { iso, sha256Hex, type Clock } from "../util.ts";

declare module "fastify" {
  interface FastifyRequest {
    idemKey?: { key: string; route: string; bodyHash: string };
  }
}

/** Pure / auth endpoints never need replay protection. */
const EXEMPT = new Set(["/v1/dev/login", "/v1/verify"]);

function caller(req: FastifyRequest): string {
  if (req.persona) return req.persona.persona_id;
  const t = req.headers["x-cosign-token"];
  if (typeof t === "string") return "cosign:" + sha256Hex(t).slice(0, 32);
  const k = req.headers["x-connector-key"];
  if (typeof k === "string") return "connector";
  return "anon";
}

function stableHash(body: unknown): string {
  try {
    return sha256Hex(canonicalJson(body ?? null));
  } catch {
    return sha256Hex(JSON.stringify(body ?? null));
  }
}

export function registerIdempotency(app: FastifyInstance, db: DB, clock: Clock) {
  const get = db.prepare("SELECT status, response_json FROM idempotency WHERE key = ? AND route = ?");
  const put = db.prepare("INSERT OR IGNORE INTO idempotency (key, route, status, response_json, created_at) VALUES (?, ?, ?, ?, ?)");

  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "POST") return;
    const raw = req.headers["idempotency-key"];
    if (raw === undefined) return;
    const path = req.url.split("?")[0];
    if (EXEMPT.has(path)) return;
    if (typeof raw !== "string" || raw.length < 8 || raw.length > 200 || !/^[\x21-\x7e]+$/.test(raw)) {
      throw errors.badRequest("Idempotency-Key must be 8-200 printable ASCII characters");
    }
    const route = `${caller(req)} POST ${path}`;
    const bodyHash = stableHash(req.body);
    const hit = get.get(raw, route) as { status: number; response_json: string } | undefined;
    if (hit) {
      const stored = JSON.parse(hit.response_json) as { bodyHash: string; body: string };
      if (stored.bodyHash !== bodyHash) throw errors.conflict("Idempotency-Key was already used with a different request body");
      reply.header("idempotent-replay", "true");
      reply.code(hit.status).type("application/json").send(stored.body);
      return reply;
    }
    req.idemKey = { key: raw, route, bodyHash };
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.idemKey || reply.statusCode < 200 || reply.statusCode >= 300 || typeof payload !== "string") return payload;
    put.run(req.idemKey.key, req.idemKey.route, reply.statusCode, JSON.stringify({ bodyHash: req.idemKey.bodyHash, body: payload }), iso(clock.now()));
    return payload;
  });
}
