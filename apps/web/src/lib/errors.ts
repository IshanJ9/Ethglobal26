import { ApiError, type ErrorCode } from "./api";

// AGENT_B.md 4.2: error.code -> message shown to the user.
const MESSAGES: Partial<Record<ErrorCode | "network", string>> = {
  unauthorized: "Session expired. Sign in again.",
  forbidden: "You do not have permission for this action.",
  not_found: "Not found, or not visible to you.",
  invalid_state: "That item changed. Refresh to see the latest version.",
  approval_required:
    "Manager approval is required before this step. Denied approvals block attestation and payout.",
  approval_denied:
    "Manager approval is required before this step. Denied approvals block attestation and payout.",
  grant_closed: "This link is no longer active.",
  signature_mismatch: "The signature did not match the expected wallet or chain.",
  world_verification_failed: "World verification failed. Try again.",
  gate_failed: "Too little evidence is verified yet to pay a bonus.",
  upstream_unavailable: "A service is temporarily unavailable. Try again shortly.",
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network") return e.message;
    if (e.code === "chain_error") {
      const revert = e.details?.revert;
      return `The chain rejected the transaction${revert ? `: ${String(revert)}` : "."}`;
    }
    return MESSAGES[e.code] ?? e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}
