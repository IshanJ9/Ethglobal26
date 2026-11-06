# World ID Agent Pass: integration debrief

## What it protects

Proofwork's **review agent** (`review-agent.proofwork-demo.eth`, running on 0G Private Computer) decrypts an employee's
evidence vault and writes HR text about them: strengths, concerns, a peer comparison and promotion readiness. That is the most
sensitive thing an agent does in the product. With Agent Pass on (`AGENT_PASS_MODE=live`), the agent **cannot start**
until a verified human approves that exact request with World ID.

## The journey

1. HR (or the employee's manager) ticks a person on the cluster board and clicks **Prepare review**.
2. The workflow pauses. The backend starts an OIDC **Device Authorization Grant** with World IdP
   (`POST https://auth.world.org/api/v1/device_authorization`, `scope=openid`, `client_secret_basic`).
   It requests an essential `acr` claim of `orb` or `orb-face`, and the device grant always forces fresh authentication.
   The operation (`review.generate`, employee, cycle, peer) is saved verbatim with its `keccak(canonicalJson)` hash.
   The device code is envelope-encrypted at rest.
3. The web shows a QR code and user code (`AgentPassGate`). The human approves in World App.
4. The backend polls the token endpoint server side, respecting `interval` and `slow_down`, then **validates the ID token**:
   - RS256 signature against `jwks_uri`, plus `iss = https://auth.world.org`, `aud = client_id` and `exp`;
   - `acr ∈ {orb, orb-face}`, and `auth_time` no older than the checkpoint (and not in the future);
   - `(iss, sub)` must equal the World ID linked to this persona. The first approval enrolls it, atomically, and only
     if no other account holds that `(iss, sub)`.
5. On approval, review creation sends the checkpoint id. At the resource (`ReviewService.create`), before any vault
   read, the backend checks that the approval:
   - belongs to the same persona;
   - is approved and unused;
   - has the same operation hash;
   - comes from a World ID authentication no older than 10 minutes.

   It is marked `used` in one conditional update, so an approval runs the agent once.
6. The review records `agent_pass` (checkpoint id, operation hash, `acr`, `auth_time`, hashed subject), and the review
   page shows "Agent authorization (World ID Agent Pass)". Every step is in the audit log (`agent_pass.*`).

## Denied paths (all tested in `apps/api/test/agentpass.test.ts` against a fake IdP with real RS256 keys)

| Case | Result |
|---|---|
| No checkpoint, or still pending | 401 `world_verification_failed`, `reason: agent_pass_required`; the agent does not run |
| Approval reused | 401 "already used" |
| Approval used for a different operation (other employee or peer) | 401 "different operation", and the approval is not consumed |
| A different World ID approves | denied: "not the one linked to this account" |
| World ID already linked to another persona | denied |
| Account without Orb verification (`acr` device or none) | denied |
| Stale authentication (`auth_time` before the checkpoint) | denied |
| Human declines (`access_denied`), lets it expire, or cancels | denied, expired or cancelled |
| Employee tries to authorize the agent | 403. They cannot see HR's checkpoints (404) |
| Approval older than 10 minutes at execution | 401 |

## Why Agent Pass, next to World ID 4.0 proofs

Proofwork already uses World ID 4.0 (IDKit) proofs for one-off human signatures bound to a hash: approve a scorecard,
co-sign a claim, anchor a review, acknowledge a review. Agent Pass adds what those cannot:

- **Human continuity.** The same human is recognised across sessions through the pairwise `sub`, so we enforce
  *this* HR person's identity, not just *a* human.
- **A standard OIDC human-in-the-loop checkpoint** for a **headless agent** (device flow).

## Configuration

- Portal: https://auth.world.org/portal. Client auth `client_secret_basic`, accepted accounts **Orb**, and an HTTPS
  callback URL (required even for device-only clients).
- `apps/api/.env`: `AGENT_PASS_MODE=live`, `WORLD_IDP_CLIENT_ID=…`, `WORLD_IDP_CLIENT_SECRET=worldidp_client_secret_…`.
- `GET /v1/config/public` reports `agent_pass_mode`. The web gates "Prepare review" automatically.

Code: `apps/api/src/agentpass/agentpass.ts`, `apps/api/migrations/005_agent_pass.sql`,
`apps/web/src/components/AgentPassGate.tsx`, spec 1.6.0 (`/v1/agent-pass/checkpoints*`).

## Feedback for World

- **What went well:** discovery advertises everything needed (device grant, `claims_parameter_supported`, the
  `acr_values` list), so a backend-only integration was straightforward with `jose`.
- **Friction:** the device flow requires a registered HTTPS redirect URI even though it never redirects. That is
  confusing for headless agents and localhost development.
- **Missing:** an operation-binding parameter (for example `binding_message`, as in CIBA, or RAR
  `authorization_details`) shown on the phone. Today the human approves "sign in to Proofwork", and the binding to the
  exact operation lives only on our side.
