// Thin Proofwork API client. The ingest app uses ONLY spec endpoints (spec/openapi.yaml):
// /v1/dev/login, /v1/org/*, /v1/cycles, /v1/claims*, /v1/evidence/ingest. No private backdoors.
import { randomUUID } from "node:crypto";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export class ProofworkApi {
  constructor(private readonly base: string, private readonly fetchImpl: Fetch = fetch as unknown as Fetch) {}

  async call<T = any>(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string>; idempotent?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    // One key per logical action (the caller retries with the same headers object if it wants replay).
    if (opts.idempotent && method !== "GET") headers["idempotency-key"] ??= randomUUID();
    const res = await this.fetchImpl(this.base.replace(/\/$/, "") + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (res.status >= 400) throw new ApiError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? `HTTP ${res.status}`);
    return json as T;
  }

  devLogin(personaId: string) {
    return this.call<{ token: string; persona: any }>("POST", "/v1/dev/login", { body: { persona_id: personaId } });
  }

  ingestEvidence(connectorKey: string, draft: unknown) {
    return this.call<any>("POST", "/v1/evidence/ingest", { body: draft, headers: { "x-connector-key": connectorKey } });
  }
}
