// Contract guard (AGENT_A 0.4):
//  (a) every request body + query is validated against openapi; unknown fields -> 400 unknown_field,
//      other schema failures -> 400 validation_failed.
//  (b) outside production every response is validated against openapi; a mismatch is replaced by a
//      500 `internal` "response contract violation" and counted, so tests catch drift immediately.
// Routes not in the spec are only allowed under /internal/*.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, errors } from "../errors.ts";
import { formatAjvErrors, loadContract, opKey, unknownFields, type Contract, type Operation } from "./openapi.ts";

export interface ContractViolation {
  route: string;
  status: number;
  errors: ReturnType<typeof formatAjvErrors>;
  at: string;
}

export interface GuardState {
  violations: ContractViolation[];
}

declare module "fastify" {
  interface FastifyRequest {
    pwOp?: Operation;
  }
  interface FastifyInstance {
    contract: Contract;
    contractGuard: GuardState;
  }
}

const isEmptyBody = (b: unknown) =>
  b === undefined || b === null || (typeof b === "object" && !Array.isArray(b) && Object.keys(b as object).length === 0);

function findOp(contract: Contract, req: FastifyRequest): Operation | undefined {
  const url = req.routeOptions.url;
  return url ? contract.operations.get(opKey(req.method, url)) : undefined;
}

export function registerContractGuard(app: FastifyInstance, opts: { validateResponses: boolean }) {
  const contract = loadContract();
  const state: GuardState = { violations: [] };
  app.decorate("contract", contract);
  app.decorate("contractGuard", state);

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      if (m === "HEAD" || m === "OPTIONS") continue;
      if (route.url.startsWith("/internal/")) continue;
      if (!contract.operations.has(opKey(m, route.url))) {
        throw new Error(`Route ${m} ${route.url} is not in spec/openapi.yaml (extra routes must live under /internal/*)`);
      }
    }
  });

  app.addHook("preHandler", async (req) => {
    const op = findOp(contract, req);
    if (!op) return;
    req.pwOp = op;

    if (op.query) {
      const q = { ...(req.query as Record<string, unknown>) };
      if (!op.query(q)) {
        const unk = unknownFields(op.query.errors);
        if (unk.length) throw errors.unknownField(unk);
        throw errors.validation("Invalid query parameters", { errors: formatAjvErrors(op.query.errors) });
      }
      req.query = q;
    }

    const body = req.body;
    if (!op.body) {
      if (!isEmptyBody(body)) {
        const fields = typeof body === "object" && body ? Object.keys(body) : ["<body>"];
        throw errors.unknownField(fields);
      }
      return;
    }
    if (body === undefined || body === null) {
      if (op.body.required) throw errors.badRequest("Request body is required");
      return;
    }
    if (!op.body.validate(body)) {
      const unk = unknownFields(op.body.validate.errors);
      if (unk.length) throw errors.unknownField(unk);
      throw errors.validation("Request body failed validation", { errors: formatAjvErrors(op.body.validate.errors) });
    }
  });

  if (!opts.validateResponses) return state;

  app.addHook("onSend", async (req, reply, payload) => {
    if (typeof payload !== "string") return payload;
    const ct = String(reply.getHeader("content-type") ?? "");
    if (!ct.includes("application/json")) return payload;
    const route = req.routeOptions.url;
    if (route?.startsWith("/internal/")) return payload;

    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return payload;
    }
    const status = reply.statusCode;
    const op = req.pwOp ?? findOp(contract, req);
    let validate = status >= 400 ? contract.errorSchema : undefined;
    let problem: string | undefined;
    if (status < 400) {
      if (!op) problem = "no openapi operation for this route";
      else if (!op.responses.has(String(status))) problem = `status ${status} not documented for ${op.operationId}`;
      else validate = op.responses.get(String(status)) ?? undefined;
    }
    if (!problem && validate && validate(data)) return payload;

    const v: ContractViolation = {
      route: `${req.method} ${route ?? req.url.split("?")[0]}`,
      status,
      errors: problem ? [{ path: "/", message: problem, keyword: "status" }] : formatAjvErrors(validate?.errors),
      at: new Date().toISOString(),
    };
    state.violations.push(v);
    req.log.error({ contractViolation: v }, "response contract violation");
    reply.code(500);
    return JSON.stringify(new ApiError(500, "internal", "response contract violation", { violation: v }).toBody());
  });

  return state;
}
