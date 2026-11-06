import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "@proofwork/shared";
import { getSession } from "./session";

export type Schemas = components["schemas"];
export type Persona = Schemas["Persona"];
export type PublicConfig = Schemas["PublicConfig"];
export type ErrorCode = Schemas["Error"]["error"]["code"];

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8787";

/** Compiled-in spec major. A mismatch with the server blocks the UI (INTEGRATION 5.9). */
export const SPEC_MAJOR = 1;

/** Last X-Spec-Version seen on any response (only readable if the API exposes the header via CORS). */
let lastSpecHeader: string | null = null;
export const getLastSpecHeader = () => lastSpecHeader;

const middleware: Middleware = {
  onRequest({ request }) {
    const session = getSession();
    if (session && !request.headers.has("Authorization")) {
      request.headers.set("Authorization", `Bearer ${session.token}`);
    }
    // User actions set their own per-action key via useAction/idem (lib/action.ts) so retries reuse it.
    // This fallback only covers a POST made outside useAction; it gives no double-click protection.
    if (request.method === "POST" && !request.headers.has("Idempotency-Key")) {
      request.headers.set("Idempotency-Key", crypto.randomUUID());
    }
    return request;
  },
  onResponse({ response }) {
    const v = response.headers.get("X-Spec-Version");
    if (v) lastSpecHeader = v;
    return response;
  },
};

/** The single typed HTTP client. All API calls go through this. */
// Never use the browser HTTP cache: every response is live and per caller, and some routes key on a header
// (X-Cosign-Token) rather than the URL, so a cached 410 for one co-sign link was served for the next link.
export const api = createClient<paths>({ baseUrl: API_BASE, fetch: (req: Request) => fetch(req, { cache: "no-store" }) });
api.use(middleware);

export class ApiError extends Error {
  constructor(
    public code: ErrorCode | "network",
    message: string,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Unwrap an openapi-fetch result: return data or throw a typed ApiError. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let res: { data?: T; error?: unknown; response: Response };
  try {
    res = await call;
  } catch (e) {
    throw new ApiError("network", `Cannot reach the API at ${API_BASE}`, 0);
  }
  if (res.data !== undefined && !res.error) return res.data;
  const body = res.error as Schemas["Error"] | undefined;
  const err = body?.error;
  throw new ApiError(
    err?.code ?? "internal",
    err?.message ?? `Request failed (${res.response.status})`,
    res.response.status,
    err?.details,
  );
}
