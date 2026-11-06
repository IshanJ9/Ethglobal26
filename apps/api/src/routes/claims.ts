import type { FastifyInstance } from "fastify";
import type { Hex } from "@proofwork/crypto";
import { me, makeAuthenticate } from "../auth/auth.ts";
import type { ClaimCreate } from "../claims/service.ts";
import type { WorldResult } from "../world/verifier.ts";
import type { Services } from "../services.ts";

const cosignToken = (h: unknown) => (typeof h === "string" ? h : undefined);

export async function claimRoutes(app: FastifyInstance, { svc }: { svc: Services }) {
  const auth = { onRequest: makeAuthenticate(svc.jwt, svc.org) };
  const id = (req: { params: unknown }) => (req.params as { claim_id: string }).claim_id;

  app.post("/v1/claims", auth, async (req, reply) => reply.code(201).send(await svc.claims.create(me(req), req.body as ClaimCreate)));
  app.get("/v1/claims", auth, async (req) => ({ items: svc.claims.list(me(req), req.query as { cycle_id?: string; state?: string }) }));
  app.get("/v1/claims/:claim_id", auth, async (req) => svc.claims.get(me(req), id(req)));
  app.patch("/v1/claims/:claim_id/draft", auth, async (req) => svc.claims.editDraft(me(req), id(req), req.body as any));
  app.get("/v1/claims/:claim_id/signing-package", auth, async (req) => svc.claims.signingPackage(me(req), id(req)));
  app.post("/v1/claims/:claim_id/submit", auth, async (req) =>
    svc.claims.submit(me(req), id(req), (req.body as { employee_signature: Hex }).employee_signature),
  );
  app.post("/v1/claims/:claim_id/cosign-grants", auth, async (req, reply) => {
    const b = req.body as { auth_method: "world_id" | "magic_link_wallet"; ttl_hours?: number };
    return reply.code(201).send(svc.claims.createGrant(me(req), id(req), b.auth_method, b.ttl_hours ?? 72));
  });

  // Co-signer endpoints: X-Cosign-Token only, no JWT.
  app.get("/v1/cosign/view", async (req) => svc.claims.view(cosignToken(req.headers["x-cosign-token"])));
  app.post("/v1/cosign/sign", async (req) => {
    const b = req.body as { signature: Hex; world_result?: WorldResult };
    return svc.claims.sign(cosignToken(req.headers["x-cosign-token"]), b.signature, b.world_result);
  });
  app.post("/v1/cosign/decline", async (req) =>
    svc.claims.decline(cosignToken(req.headers["x-cosign-token"]), (req.body as { reason: string }).reason),
  );
}
