// F2-F5 routes: runs, scorecards, approvals, chain, payouts, verify, shred.
import type { FastifyInstance } from "fastify";
import { isHr, isInternal, me, makeAuthenticate } from "../auth/auth.ts";
import { errors } from "../errors.ts";
import type { WorldResult } from "../world/verifier.ts";
import type { VerifyRequest } from "../verify/service.ts";
import type { Services } from "../services.ts";

type P = Record<string, string>;

export async function flowRoutes(app: FastifyInstance, { svc }: { svc: Services }) {
  const auth = { onRequest: makeAuthenticate(svc.jwt, svc.org) };
  const params = (req: { params: unknown }) => req.params as P;

  // ---- runs (evidence agent) ----
  app.post("/v1/runs", auth, async (req, reply) => {
    const b = req.body as { employee_id: string; cycle_id: string };
    return reply.code(202).send(svc.runs.start(me(req), b.employee_id, b.cycle_id));
  });
  app.get("/v1/runs/:run_id", auth, async (req) => svc.runs.getRun(me(req), params(req).run_id));

  // ---- shred ----
  app.post("/v1/evidence/:evidence_id/shred", auth, async (req) => {
    const p = me(req);
    const id = params(req).evidence_id;
    if (!svc.evidence.get(id)) throw errors.notFound("Evidence not found");
    if (!isHr(p)) throw errors.forbidden("Only HR can shred evidence");
    return svc.ledger.shred(id, p.persona_id);
  });

  // ---- scorecards ----
  app.post("/v1/scorecards", auth, async (req, reply) => {
    const b = req.body as { employee_id: string; cycle_id: string };
    return reply.code(201).send(svc.scorecardSvc.create(me(req), b.employee_id, b.cycle_id));
  });
  app.get("/v1/scorecards", auth, async (req) => ({ items: svc.scorecardSvc.list(me(req), req.query as { employee_id?: string; cycle_id?: string }) }));
  app.get("/v1/scorecards/:scorecard_id", auth, async (req) => svc.scorecardSvc.get(me(req), params(req).scorecard_id));
  app.get("/v1/scorecards/:scorecard_id/diff/:other_id", auth, async (req) => svc.scorecardSvc.diff(me(req), params(req).scorecard_id, params(req).other_id));
  app.post("/v1/scorecards/:scorecard_id/revise", auth, async (req, reply) =>
    reply.code(201).send(svc.scorecardSvc.revise(me(req), params(req).scorecard_id, (req.body as { reason: string }).reason)),
  );

  // ---- approvals ----
  app.post("/v1/approvals", auth, async (req, reply) =>
    reply.code(201).send(svc.scorecardSvc.createApproval(me(req), (req.body as { scorecard_id: string }).scorecard_id)),
  );
  app.get("/v1/approvals/:approval_id", auth, async (req) => svc.scorecardSvc.getApproval(me(req), params(req).approval_id));
  app.post("/v1/approvals/:approval_id/complete", auth, async (req) =>
    svc.scorecardSvc.completeApproval(me(req), params(req).approval_id, req.body as { decision: "approve" | "deny"; comment?: string; world_result?: WorldResult }),
  );
  app.post("/v1/approvals/:approval_id/cancel", auth, async (req) => svc.scorecardSvc.cancelApproval(me(req), params(req).approval_id));

  // ---- chain ----
  app.post("/v1/chain/anchor", auth, async (req, reply) => {
    const p = me(req);
    svc.chainSvc.checkOperator(p);
    return reply.code(201).send(await svc.chainSvc.anchor(p.persona_id));
  });
  app.get("/v1/chain/batches/:batch_id", auth, async (req) => {
    if (!isInternal(me(req))) throw errors.forbidden();
    return svc.chainSvc.getBatch(params(req).batch_id);
  });
  app.post("/v1/chain/attest", auth, async (req, reply) =>
    reply.code(201).send(await svc.chainSvc.attest(me(req), (req.body as { scorecard_id: string }).scorecard_id)),
  );

  // ---- payouts ----
  app.get("/v1/payouts/:scorecard_id", auth, async (req) => svc.chainSvc.getPayout(me(req), params(req).scorecard_id));
  app.post("/v1/payouts/:scorecard_id/release", auth, async (req) => svc.chainSvc.release(me(req), params(req).scorecard_id));
  app.post("/v1/payouts/:scorecard_id/release-holdback", auth, async (req) => svc.chainSvc.releaseHoldback(me(req), params(req).scorecard_id));
  app.post("/v1/payouts/:scorecard_id/dispute", auth, async (req) =>
    svc.chainSvc.dispute(me(req), params(req).scorecard_id, (req.body as { reason: string }).reason),
  );
  app.post("/v1/payouts/:scorecard_id/resolve", auth, async (req) =>
    svc.chainSvc.resolve(me(req), params(req).scorecard_id, (req.body as { release_funds: boolean }).release_funds),
  );

  // ---- verify (public) ----
  app.post("/v1/verify", async (req) => svc.verify.verify(req.body as VerifyRequest));
}
