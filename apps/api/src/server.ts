// Fastify bootstrap: logging (redacted), body limit, helmet, CORS, spec header, contract guard,
// uniform Error responses. `buildApp` is used by main.ts and by tests via fastify.inject.
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { SPEC_VERSION, type Config } from "./config.ts";
import { ApiError, errors } from "./errors.ts";
import { registerContractGuard } from "./contract/guard.ts";
import { metaRoutes } from "./routes/meta.ts";
import { coreRoutes } from "./routes/core.ts";
import { claimRoutes } from "./routes/claims.ts";
import { flowRoutes } from "./routes/flow.ts";
import { ChainRevert } from "./chain/types.ts";
import { buildServices, type ServiceOverrides, type Services } from "./services.ts";

declare module "fastify" {
  interface FastifyInstance {
    svc: Services;
  }
}

export const BODY_LIMIT = 100 * 1024;

/** Never log credentials, tokens, salts or payloads (AGENT_A 0.9). */
const REDACT = [
  "req.headers.authorization",
  'req.headers["x-cosign-token"]',
  'req.headers["x-connector-key"]',
  "req.headers.cookie",
];

export async function buildApp(config: Config, opts: { logger?: boolean; services?: ServiceOverrides } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL, redact: { paths: REDACT, censor: "[redacted]" } },
    bodyLimit: BODY_LIMIT,
    // Query strings are validated by the contract guard, not fastify.
    routerOptions: { ignoreTrailingSlash: true },
  });

  // Accept an empty body with content-type: application/json (some POSTs carry no body).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const s = (body as string).trim();
    if (!s) return done(null, undefined);
    try {
      done(null, JSON.parse(s));
    } catch {
      done(errors.badRequest("Malformed JSON body"), undefined);
    }
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } });
  await app.register(cors, {
    origin: config.WEB_ORIGIN.split(",").map((s) => s.trim()),
    credentials: false,
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-cosign-token"],
    exposedHeaders: ["x-spec-version"],
  });

  app.addHook("onRequest", async (_req, reply) => {
    reply.header("x-spec-version", SPEC_VERSION);
  });

  registerContractGuard(app, { validateResponses: config.NODE_ENV !== "production" });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send(errors.notFound("Route not found").toBody());
  });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) req.log.error({ code: err.code }, err.message);
      return reply.code(err.status).send(err.toBody());
    }
    if (err instanceof ChainRevert) {
      req.log.warn({ op: err.op, revert: err.revert }, "chain call failed");
      return reply.code(502).send(new ApiError(502, "chain_error", "The chain rejected the transaction", { op: err.op, revert: err.revert }).toBody());
    }
    const fe = err as FastifyError;
    if (fe.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send(errors.badRequest(`Body exceeds ${BODY_LIMIT} bytes`).toBody());
    }
    if (fe.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(415).send(errors.badRequest("Content-Type must be application/json").toBody());
    }
    if (fe.statusCode === 429) {
      return reply.code(429).send(new ApiError(429, "rate_limited", "Too many requests").toBody());
    }
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send(errors.badRequest(fe.message).toBody());
    }
    req.log.error({ err: { name: fe.name, code: fe.code } }, "unhandled error");
    return reply.code(500).send(errors.internal().toBody());
  });

  const svc = buildServices(config, opts.services, (m, d) => app.log.warn(d ?? {}, m));
  app.decorate("svc", svc);
  app.addHook("onClose", async () => {
    if (!opts.services?.db) svc.db.close();
  });

  await app.register(metaRoutes, { config });
  await app.register(coreRoutes, { svc });
  await app.register(claimRoutes, { svc });
  await app.register(flowRoutes, { svc });
  return app;
}
