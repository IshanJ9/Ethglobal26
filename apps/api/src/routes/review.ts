import type { AgentOperation } from "../agentpass/agentpass.ts";
// CR-004 routes: clusters (layer 1 in cluster), employee context (layer 2), reviews (layer 3 + anchor).
import type { FastifyInstance } from "fastify";
import { canView, isInternal, makeAuthenticate, me } from "../auth/auth.ts";
import { errors } from "../errors.ts";
import { clusterIdOf } from "../db/org.ts";
import type { Services } from "../services.ts";
import type { WorldResult } from "../world/verifier.ts";

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
    const b = req.body as { employee_id: string; cycle_id: string; peer_employee_id?: string | null; agent_pass_checkpoint_id?: string | null };
    const review = await svc.reviews.create(me(req), b.employee_id, b.cycle_id, b.peer_employee_id, b.agent_pass_checkpoint_id);
    return reply.code(201).send(review);
  });

  app.get("/v1/reviews", auth, async (req) => {
    const q = req.query as { employee_id?: string; cycle_id?: string };
    return { items: svc.reviews.list(me(req), { employeeId: q.employee_id, cycleId: q.cycle_id }) };
  });

  app.get("/v1/reviews/:review_id", auth, async (req) => svc.reviews.get(me(req), (req.params as { review_id: string }).review_id));

  app.post("/v1/reviews/:review_id/anchor", auth, async (req) =>
    svc.reviews.anchor(me(req), (req.params as { review_id: string }).review_id, (req.body as { world_result?: WorldResult } | undefined)?.world_result),
  );

  // ---- World ID Agent Pass (human checkpoint for the review agent) ----
  app.post("/v1/agent-pass/checkpoints", auth, async (req, reply) => reply.code(201).send(await svc.agentPass.create(me(req), (req.body as { operation: AgentOperation }).operation)));
  app.get("/v1/agent-pass/checkpoints/:checkpoint_id", auth, async (req) => svc.agentPass.get(me(req), (req.params as { checkpoint_id: string }).checkpoint_id));
  app.post("/v1/agent-pass/checkpoints/:checkpoint_id/cancel", auth, async (req) => svc.agentPass.cancel(me(req), (req.params as { checkpoint_id: string }).checkpoint_id));

  // ---- HR agents on 0G (bonus allocation, promotion planning) ----
  app.post("/v1/agents/bonus-allocation", auth, async (req) => svc.agents.allocate(me(req), req.body as { cycle_id: string; cluster_id: string; budget: string; kind: "year_end_bonus" | "bounty" | "freelance" }));
  app.post("/v1/agents/bonus-allocation/:allocation_id/settle", auth, async (req) => svc.pool.settle(me(req), (req.params as { allocation_id: string }).allocation_id));
  app.post("/v1/voice/transcriptions", { ...auth, bodyLimit: 3 * 1024 * 1024 }, async (req) => svc.voice.transcribe(me(req), req.body as { audio_base64: string; mime_type: string; language?: string | null }));
  app.post("/v1/agents/promotion-chat", auth, async (req) => svc.agents.promote(me(req), req.body as { cycle_id: string; messages: Array<{ role: "user" | "assistant"; content: string }> }));

  // ---- zero-knowledge score proofs ----
  app.post("/v1/zk/proofs", async (req) => svc.zk.recordProof(req.body as { proof: unknown; public_signals: string[]; numeric_batch_id: number }));
  app.post("/v1/scorecards/:scorecard_id/zk-commit", auth, async (req) => svc.zk.commit(me(req), (req.params as { scorecard_id: string }).scorecard_id));
  app.get("/v1/scorecards/:scorecard_id/zk-commit", auth, async (req) => svc.zk.get(me(req), (req.params as { scorecard_id: string }).scorecard_id));
  app.get("/v1/scorecards/:scorecard_id/zk-witness", auth, async (req) => svc.zk.witness(me(req), (req.params as { scorecard_id: string }).scorecard_id));

  app.post("/v1/reviews/:review_id/acknowledge", auth, async (req) =>
    svc.reviews.acknowledge(me(req), (req.params as { review_id: string }).review_id, (req.body as { world_result?: WorldResult }).world_result),
  );
}
