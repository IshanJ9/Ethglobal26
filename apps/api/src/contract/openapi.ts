// Loads spec/openapi.yaml and compiles request/response validators with ajv 2020,
// registering components exactly like scripts/spec-check.mjs: { $id: "pw", components }.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { REPO_ROOT } from "../config.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Operation {
  operationId: string;
  method: string; // upper case
  oasPath: string; // /v1/claims/{claim_id}
  fastifyPath: string; // /v1/claims/:claim_id
  body?: { required: boolean; validate: ValidateFunction };
  query?: ValidateFunction; // coercing validator; rejects unknown params
  responses: Map<string, ValidateFunction | null>; // status -> body validator (null = no JSON body)
}

export interface Contract {
  version: string;
  operations: Map<string, Operation>; // key: "GET /v1/claims/:claim_id"
  errorSchema: ValidateFunction;
  schema(name: string): ValidateFunction;
  api: Json;
}

/** "#/components/..." -> "pw#/components/..." so inline schemas resolve against the registered components. */
function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === "$ref" && typeof v === "string" && v.startsWith("#/") ? "pw" + v : rewriteRefs(v);
    }
    return out;
  }
  return node;
}

export const opKey = (method: string, fastifyPath: string) => `${method.toUpperCase()} ${fastifyPath}`;
export const toFastifyPath = (p: string) => p.replace(/\{([^}]+)\}/g, ":$1");

let cached: Contract | undefined;

export function loadContract(): Contract {
  if (cached) return cached;
  const api = YAML.parse(readFileSync(join(REPO_ROOT, "spec/openapi.yaml"), "utf8"));
  const mk = (coerce: boolean) => {
    const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: coerce, useDefaults: coerce });
    addFormats(ajv);
    ajv.addSchema({ $id: "pw", components: api.components });
    return ajv;
  };
  const ajv = mk(false);
  const ajvQuery = mk(true);
  const deref = (x: Json) => {
    if (x && typeof x.$ref === "string" && x.$ref.startsWith("#/")) {
      return x.$ref.slice(2).split("/").reduce((a: Json, k: string) => a?.[k], api);
    }
    return x;
  };
  const schemaCache = new Map<string, ValidateFunction>();
  const schema = (name: string) => {
    let v = schemaCache.get(name);
    if (!v) {
      v = ajv.getSchema(`pw#/components/schemas/${name}`);
      if (!v) throw new Error(`openapi schema ${name} not found`);
      schemaCache.set(name, v);
    }
    return v;
  };

  const operations = new Map<string, Operation>();
  for (const [oasPath, item] of Object.entries<Json>(api.paths)) {
    for (const [m, raw] of Object.entries<Json>(item)) {
      if (!["get", "post", "patch", "put", "delete"].includes(m)) continue;
      const op: Operation = {
        operationId: raw.operationId,
        method: m.toUpperCase(),
        oasPath,
        fastifyPath: toFastifyPath(oasPath),
        responses: new Map(),
      };
      const rb = deref(raw.requestBody);
      const bodySchema = rb?.content?.["application/json"]?.schema;
      if (bodySchema) op.body = { required: !!rb.required, validate: ajv.compile(rewriteRefs(bodySchema)) };

      const params = [...(item.parameters ?? []), ...(raw.parameters ?? [])].map(deref);
      const q = params.filter((p: Json) => p.in === "query");
      const qs: Json = { type: "object", additionalProperties: false, properties: {}, required: [] as string[] };
      for (const p of q) {
        qs.properties[p.name] = rewriteRefs(p.schema ?? {});
        if (p.required) qs.required.push(p.name);
      }
      op.query = ajvQuery.compile(qs);

      for (const [status, r] of Object.entries<Json>(raw.responses ?? {})) {
        const s = deref(r)?.content?.["application/json"]?.schema;
        op.responses.set(status, s ? ajv.compile(rewriteRefs(s)) : null);
      }
      operations.set(opKey(op.method, op.fastifyPath), op);
    }
  }
  cached = { version: api.info.version, operations, errorSchema: schema("Error"), schema, api };
  return cached;
}

export function formatAjvErrors(errs: ErrorObject[] | null | undefined) {
  return (errs ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? e.keyword, keyword: e.keyword }));
}

/** Names of properties rejected by additionalProperties:false, as JSON-pointer-ish paths. */
export function unknownFields(errs: ErrorObject[] | null | undefined): string[] {
  return (errs ?? [])
    .filter((e) => e.keyword === "additionalProperties")
    .map((e) => `${e.instancePath ? e.instancePath.slice(1).replace(/\//g, ".") + "." : ""}${(e.params as { additionalProperty: string }).additionalProperty}`);
}
