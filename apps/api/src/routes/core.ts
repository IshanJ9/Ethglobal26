// Auth, org, audit, evidence, scores, dev routes. Handlers stay thin; logic lives in services.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { components } from "@proofwork/shared";
import { canView, isHr, isInternal, me, makeAuthenticate, viewableEmployee, visibleEmployeeIds } from "../auth/auth.ts";
import { errors } from "../errors.ts";
import { toEvidenceItem, type EvidenceIngest } from "../ledger/ledger.ts";
import { seedScenario } from "../fixtures.ts";
import { expandEvent } from "../dev/expand.ts";
import { iso, safeEqual } from "../util.ts";
import type { Services } from "../services.ts";

type Q = Record<string, string | number | undefined>;

export async function coreRoutes(app: FastifyInstance, { svc }: { svc: Services }) {
  const authenticate = makeAuthenticate(svc.jwt, svc.org);
  const auth = { onRequest: authenticate };
  const internalOnly = (req: FastifyRequest) => {
    if (!isInternal(me(req))) throw errors.forbidden("Not available to external co-signers");
  };

  // ---- auth ----
  if (svc.config.AUTH_MODE === "dev") {
    app.post("/v1/dev/login", async (req) => {
      const { persona_id } = req.body as { persona_id: string };
      const p = svc.org.persona(persona_id);
      if (!p) throw errors.unauthorized("Unknown persona");
      svc.audit.append(iso(svc.clock.now()), p.persona_id, "auth.dev_login", p.persona_id, {});
      return { token: await svc.jwt.sign(p), persona: p };
    });
  }
  app.get("/v1/me", auth, async (req) => me(req));

  // ---- org ----
  app.get("/v1/org/employees", auth, async (req) => {
    const p = me(req);
    return { items: svc.org.employees().filter((e) => canView(p, e)) };
  });
  app.get("/v1/org/plans", auth, async (req) => {
    internalOnly(req);
    return { items: svc.org.plans() };
  });
  app.get("/v1/org/plans/:plan_id", auth, async (req) => {
    internalOnly(req);
    const plan = svc.org.plan((req.params as { plan_id: string }).plan_id);
    if (!plan) throw errors.notFound("Plan not found");
    return plan;
  });
  app.get("/v1/cycles", auth, async () => ({ items: svc.org.cycles() }));

  // ---- audit ----
  app.get("/v1/audit", auth, async (req) => {
    const p = me(req);
    const q = req.query as Q;
    const limit = Number(q.limit ?? 50);
    const after = q.cursor !== undefined ? Number(q.cursor) : 0;
    if (!Number.isSafeInteger(after) || after < 0) throw errors.validation("cursor must be a non-negative integer string");
    const rows = svc.audit.list({ after, limit: limit + 1, actors: isHr(p) ? undefined : [p.persona_id] });
    const items = rows.slice(0, limit);
    return { items, next_cursor: rows.length > limit ? String(items[items.length - 1].seq) : null };
  });

  // ---- evidence ----
  app.get("/v1/evidence", auth, async (req) => {
    const p = me(req);
    const q = req.query as Q;
    const ids = q.employee_id ? [viewableEmployee(p, svc.org, String(q.employee_id)).employee_id] : visibleEmployeeIds(p, svc.org);
    const rows = svc.evidence.list({ employeeIds: ids, cycleId: q.cycle_id as string | undefined, status: q.status as string | undefined });
    return { items: rows.map(toEvidenceItem) };
  });
  app.get("/v1/evidence/:evidence_id", auth, async (req) => {
    const p = me(req);
    const r = svc.evidence.get((req.params as { evidence_id: string }).evidence_id);
    if (!r || !canView(p, svc.org.employee(r.employee_id))) throw errors.notFound("Evidence not found");
    return toEvidenceItem(r);
  });
  app.post(
    "/v1/evidence/ingest",
    {
      onRequest: async (req) => {
        const key = req.headers["x-connector-key"];
        if (typeof key !== "string" || !safeEqual(key, svc.config.CONNECTOR_KEY)) throw errors.unauthorized("Invalid connector key");
      },
    },
    async (req, reply) => {
      const body = req.body as EvidenceIngest;
      const { item } = svc.ledger.ingest(body, { actor: `connector:${body.source}` });
      return reply.code(201).send(item);
    },
  );

  // ---- scores ----
  app.post("/v1/scores/compute", auth, async (req) => {
    const p = me(req);
    const body = req.body as components["schemas"]["ComputeRequest"];
    viewableEmployee(p, svc.org, body.employee_id);
    return svc.compute.compute(body);
  });

  // ---- dev ----
  if (svc.config.AUTH_MODE === "dev") {
    app.post("/v1/dev/inject", auth, async (req) => {
      const p = me(req);
      if (!isInternal(p)) throw errors.forbidden();
      const { step_id } = req.body as { step_id: string };
      const step = (seedScenario().steps as any[]).find((s) => s.step_id === step_id);
      if (!step) throw errors.notFound(`Unknown step_id ${step_id}`);
      const ids: string[] = [];
      for (const ev of step.events) {
        for (const e of expandEvent(ev)) {
          const { claim_ref, ...ingest } = e;
          // s2 shortcut: a claim_ref event stands for an already co-signed claim, so it enters verified.
          const { item } = svc.ledger.ingest(ingest as EvidenceIngest, { actor: `dev:${p.persona_id}`, status: claim_ref ? "verified" : undefined });
          ids.push(item.evidence_id);
        }
      }
      return { step_id, evidence_ids: ids };
    });
  }
}
