// The single error type. Every error response is `{ error: { code, message, details? } }`
// with `code` from the openapi Error enum (the type below is generated from it).
import type { components } from "@proofwork/shared";

export type ErrorCode = components["schemas"]["Error"]["error"]["code"];
export type ErrorBody = components["schemas"]["Error"];

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const errors = {
  badRequest: (m: string, d?: Record<string, unknown>) => new ApiError(400, "bad_request", m, d),
  unknownField: (fields: string[]) => new ApiError(400, "unknown_field", `Unknown field(s): ${fields.join(", ")}`, { fields }),
  validation: (m: string, d?: Record<string, unknown>) => new ApiError(400, "validation_failed", m, d),
  unauthorized: (m = "Authentication required") => new ApiError(401, "unauthorized", m),
  forbidden: (m = "Forbidden") => new ApiError(403, "forbidden", m),
  notFound: (m = "Not found") => new ApiError(404, "not_found", m),
  conflict: (m: string, d?: Record<string, unknown>) => new ApiError(409, "conflict", m, d),
  invalidState: (m: string, d?: Record<string, unknown>) => new ApiError(409, "invalid_state", m, d),
  internal: (m = "Internal error", d?: Record<string, unknown>) => new ApiError(500, "internal", m, d),
};
