// CR-004 routes: clusters (layer 1 in cluster), employee context (layer 2), reviews (layer 3 + anchor).
import type { FastifyInstance } from "fastify";
import { canView, isInternal, makeAuthenticate, me } from "../auth/auth.ts";
import { errors } from "../errors.ts";
import { clusterIdOf } from "../db/org.ts";
import type { Services } from "../services.ts";

export async function reviewRoutes(app: FastifyInstance, { svc }: { svc: Services }) {
  const auth = { onRequest: makeAuthenticate(svc.jwt, svc.org) };

  app.get("/v1/clusters", auth, async (req) => {
    if (!isInternal(me(req))) throw errors.forbidden("Not available to external co-signers");
    return { items: svc.clusters.list() };
  });

  app.get("/v1/clusters/:cluster_id/board", auth, async (req) => {
    const { cluster_id } = req.params as { cluster_id: string };
    const { cycle_id } = req.query as { cycle_id: string };
    return svc.clusters.board(cluster_id, cycle_id, me(req));
  });

  app.get("/v1/employees/:employee_id/context", auth, async (req) => {
    const p = me(req);
    const { employee_id } = req.params as { employee_id: string };
    const { cycle_id } = req.query as { cycle_id: string };
    const emp = svc.org.employee(employee_id);
    if (!emp || !isInternal(p) || !canView(p, emp)) throw errors.notFound("Employee not found");
    const cl = clusterIdOf(emp);
    if (!cl) throw errors.notFound("Employee is not in a peer cluster");
    const { _notes, ...report } = svc.contextSvc.report(employee_id, cycle_id, svc.clusters.computeAll(cl, cycle_id));
    return report;
  });

  app.post("/v1/reviews", auth, async (req, reply) => {
    const b = req.body as { employee_id: string; cycle_id: string; peer_employee_id?: string | null };
    const review = await svc.reviews.create(me(req), b.employee_id, b.cycle_id, b.peer_employee_id);
    return reply.code(201).send(review);
  });

  app.get("/v1/reviews", auth, async (req) => {
    const q = req.query as { employee_id?: string; cycle_id?: string };
    return { items: svc.reviews.list(me(req), { employeeId: q.employee_id, cycleId: q.cycle_id }) };
  });

  app.get("/v1/reviews/:review_id", auth, async (req) => svc.reviews.get(me(req), (req.params as { review_id: string }).review_id));

  app.post("/v1/reviews/:review_id/anchor", auth, async (req) => svc.reviews.anchor(me(req), (req.params as { review_id: string }).review_id));
}
