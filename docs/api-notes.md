# API notes (`apps/api`, Agent A)

What the backend does, what is real and what is mocked, how to run and check it, and its known limits.
Spec version **1.2.0** (1.0.0 + CR-001, CR-003). Last updated Fri 6 Nov 2026 (IST).

> **Agents collect, code computes, humans decide, chain proves.** No model output is ever a number in a score;
> no scorecard is attested without an approved human approval; nothing is paid without an attestation.

## 1. Real vs mock (update this table before the final demo)

Every external dependency sits behind an adapter. **Mock is the default** and the UI shows a MOCK badge for each
mocked mode (read from `GET /v1/config/public`).

| Area | Switch | Mock (default) | Live | Live status |
|---|---|---|---|---|
| Chain (Arc) | `CHAIN_MODE` | `MockChain`: in-process registry + vault with the same revert rules and payout/revision math as AGENT_B 2.1/2.2, state persisted in SQLite, each cycle pre-funded with 1,000,000 USDC | `ViemChain`: frozen interface ABIs, two role keys, waits for receipts, parses `ScoreAttested`; wrapped in `ScaledChain` when `CHAIN_AMOUNT_DIVISOR > 1` | **Run live on Arc testnet (5042002)**, Fri 6 Nov 2026: `chain:probe` OK; `e2e:chain` and `e2e:chain --full` passed (anchor, attest, registerPlan, release, revision with `applyRevision` forfeit, verify) at divisor 10000. One run costs about 0.45 USDC of cycle funds + about 0.011 USDC gas per key. |
| World step-up | `WORLD_MODE` | Accepts `{adapter:"mock", payload:{action, signal, nullifier}}` bound to the server's action + challenge; nullifier replay rejected | World ID **4.0** cloud verify `POST developer.world.org/api/v4/verify/{rp_id}`, IDKit payload forwarded as-is, action/signal (`hashToField`) binding, environment check, replay table | **Not run against the real portal** (unit-tested against a fake portal). Agent Pass fails closed until U1 is answered. Needs CR-002 (`world_rp_context`). |
| AI draft (0G Private Computer) | `ZEROG_MODE` | Deterministic regex extractor (`provider:"mock"`, `tee_verified:null`) | OpenAI-compatible chat completion with `X-0G-Provider-Trust-Mode: private`, `verify_tee:true`; trace recorded in `InferenceRecord` | **Not run**: no `ZEROG_API_KEY` yet (U2). `zerog:probe` tests it in one command. A failed live call falls back to the mock extractor and is labelled MOCK. |
| Encrypted replica (0G Storage) | `ZEROG_MODE` | Encrypted payload written to `apps/api/data/replica/<root>.bin` | `@0gfoundation/0g-storage-ts-sdk` upload (Galileo testnet, turbo indexer) | **Not run**: needs `ZEROG_STORAGE_*` + `ZEROG_PRIVATE_KEY`. `zerog:probe` tests it. |
| Evidence connectors | n/a | Deterministic connectors over `spec/fixtures/seed-scenario.json` "collect" steps | (real GitHub/Jira/CRM adapters are roadmap) | Demo data only. |

Never present a mock proof as verified: mock World results, mock 0G traces and mock chain tx hashes are all
labelled by the modes in `/v1/config/public`.

## 2. Run it

```bash
pnpm install
pnpm --filter @proofwork/api keys:gen      # optional: writes apps/api/.env (gitignored) with real secrets + role keys
pnpm --filter @proofwork/api seed:reset    # wipe DB + replicas, load org/plans/cycles (stop the API first)
pnpm dev                                   # API on :8787 (+ web on :3000)
```

On a fresh clone with no `apps/api/.env`, the API falls back to the repo's `.env.example` (outside production
only) and prints a warning: those are public **test placeholders**, fine for the mock demo and nothing else. A fresh
clone runs `pnpm install --frozen-lockfile && pnpm --filter @proofwork/api seed:reset && pnpm dev` with no other
setup (checked on Fri 6 Nov: spec:check, 102 tests and the HTTP e2e story all green in a clean clone).

Optional variables the API also reads (all have defaults; not in the frozen `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` disables response validation and the `.env.example` fallback, forbids `WEB_ORIGIN=*` |
| `HOST` | `0.0.0.0` | listen address |
| `WEB_ORIGIN` | `http://localhost:3000` | CORS allow-list (comma-separated); named in INTEGRATION 3 |
| `LOG_LEVEL` | `info` | pino level |
| `RATE_LIMIT_PER_MIN` | `600` | global per-IP budget (route limits are capped by it) |
| `CHAIN_AMOUNT_DIVISOR` | `1` | vault runs at 1/N of the real amounts (testnet funding); API amounts stay full scale, targets must divide exactly. Live uses `10000`; the UI must label it (CR-003) |
| `WORLD_ENVIRONMENT` | `production` | expected World environment in `WORLD_MODE=live` (`staging` for the simulator) |

| Command | Proves |
|---|---|
| `pnpm spec:check` | spec, fixtures, vectors (JS + Python + TS crypto), ABIs, generated types are consistent |
| `pnpm --filter @proofwork/api test` | 107 tests: engine vs vectors and seed expectations, contract guard, claims F1, approvals, chain behaviour, verify, negative tests n01-n18, resilience |
| `pnpm e2e:demo` | full story s1 -> c1 -> v1 attest/release -> deny path -> s3 revert -> v2 + applyRevision -> s4 carry-forward -> shred, every number checked against the fixtures (in-process, ~1-2 s). `E2E_BASE_URL=http://localhost:8787` runs it against a server |
| `pnpm --filter @proofwork/api demo:script [--live]` | prints the exact click order, ids and expected numbers for the demo video |
| `pnpm --filter @proofwork/api chain:probe` | (live) chain id, roles granted to our two keys, asset decimals, cycle balances, gas |
| `pnpm e2e:chain` | (live, G2) anchor + attest + registerPlan + release on Arc testnet. Uses a fresh random `ORG_SECRET` per run; **each run reserves testnet USDC from the cycle fund** |
| `CHAIN_TEST_LIVE=1 pnpm --filter @proofwork/api test` | the ChainClient behaviour suite against the live contracts too |
| `pnpm --filter @proofwork/api zerog:probe` | (live) one 0G inference call and one 0G Storage upload; prints trace metadata only |

## 3. Behaviour the web app should know

- **Contract guard.** Every request body/query is validated against `spec/openapi.yaml` (unknown field -> 400 `unknown_field`, schema failure -> 400 `validation_failed`). Outside production every response is validated too; a drift becomes a 500 "response contract violation". Non-spec routes can only live under `/internal/*`.
- **Auth.** Dev login issues a 12 h HS256 JWT. Cross-user access to a resource is **404**, not 403 (no id probing); role violations on a known resource are 403 (e.g. self-approval).
- **Errors.** Always `{error:{code,message,details?}}`. Chain reverts are **502 `chain_error`** with `details.op` and `details.revert`. Unexpected 500s carry `details.request_id` (matches the server log line).
- **Idempotency-Key.** On any POST: the same key + caller + path replays the first 2xx response; the same key with a different body is 409; keys are 8-200 printable chars. Generate **one key per user action** and reuse it on retries (a new key per request does not protect against double clicks).
- **Rate limits.** Per IP: 600/min overall; dev login 30, claim drafting 30, co-sign view 60, co-sign sign/decline 30, verify 120. 429 uses `rate_limited`.
- **Chain writes are serialised** in the API process, so concurrent attest/anchor calls cannot race; the loser gets a clean 409.
- **Attest** auto-anchors unanchored evidence, supersedes the latest live attestation, registers the vault plan on the first attest, and calls `applyRevision` when a released payout is superseded. The attestation is stored as soon as it lands; if a later vault call fails (502), the next payout call finishes it ("settle"), exactly once.
- **Deny** is final for that version and attest returns **409 `approval_required`** (as negative test n02 specifies; `approval_denied` is not used).
- **Diff direction.** `GET /v1/scorecards/{to}/diff/{from}`: deltas are `to - from` (call it as `/{v2}/diff/{v1}`).
- **World actions** are fixed strings, `pw-approve-scorecard` (signal = `Approval.challenge`) and `pw-cosign-claim` (signal = the claim's EIP-712 digest), because World actions are registered ahead of time; each proof is bound to its own challenge.
- **Claims** may only target KRAs not fed by a system of record (`source` cosign/worklog/manual; `client_engagement` in the eng plan). The co-signer cannot be the employee. `occurred_on` must lie inside the cycle.
- **Co-sign grants**: one live grant per claim (a new grant revokes the old one); every later call on a closed/expired grant is 410 `grant_closed`; the view returns only that one claim, including its `ai_flags` (CR-001).
- **Payout** reads are chain truth for the scorecard's (subject, cycle); after a revision the governing attestation is the new one, so v1 and v2 show the same payout.
- **Verify** without a reveal still checks Merkle inclusion against the on-chain root, revocation, the hash chain and the formula hash; with a reveal it also recomputes the commitment.

## 4. Data and privacy

- SQLite (WAL) at `apps/api/data/proofwork.db`; plain SQL migrations in `apps/api/migrations`.
- Each evidence record and claim has its own random 32-byte data key (AES-256-GCM), wrapped under `DATA_KEY`. **Shred** deletes the wrapped key, ciphertexts, salt and replica pointer (and the local replica file). The commitment and Merkle leaf remain, so `/v1/verify` reports `evidence_not_shredded:false` with `merkle_proof_valid:true`. Say "designed for erasure via crypto-shredding", not "GDPR compliant".
- On chain only: pseudonymous subject ids (`subjectId(ORG_SECRET, employee, cycle)`), score commitments, evidence Merkle roots, formula hashes, approval proof hashes, multipliers. No names, no scores in clear.
- Only the **hash** of a World result is stored; nullifiers are kept (as decimal strings) for replay protection.
- Logs never contain raw claim text, salts, keys, tokens or World proofs (auth headers are redacted).
- The audit log and the evidence ledger are each hash-chained (`eventHash`); tampering is detected by `verifyChain()`.

## 5. Known limits (honest list)

1. **World and 0G live adapters are untested against real services** (the chain adapter has run live on Arc): see section 1. The mock paths are what the tests prove.
2. **Reveal for evidence/scorecards**: the API never hands out evidence or score salts, so the "verify it yourself" panel can recompute commitments only for claims (whose signing package carries the salts). A reveal endpoint for the owner would need a CR.
3. **World ID 4.0** needs a server-signed RP context for IDKit (CR-002); the signing algorithm is not implemented yet.
4. **Evidence lifecycle** `provisional -> vested` happens when the holdback is released (after `maturity_days`, 90 for engineering); `disputed` evidence and manager confirmation of unverified items have no endpoint in spec v1.
5. **Connectors** read the seed scenario; there are no real GitHub/Jira/CRM integrations.
6. **Single process**: the chain-write lock and rate limits are in-memory, so run one API instance.
7. **Mock chain funding**: each cycle starts with 1,000,000 USDC in mock mode; in live mode the vault must be funded by Agent B's `fund` script, and every `e2e:chain` run reserves real testnet funds (entitlement / `CHAIN_AMOUNT_DIVISOR`; about 0.45 USDC at 10000, so the 5 USDC in cycle 1 covers about 10 runs).
8. **No ZK proofs** in this build (roadmap).

## 6. Change requests from Agent A

| CR | What | Status |
|---|---|---|
| CR-001 | optional `ai_flags` on `CosignView` | **merged** (no reply within 30 min = ack); spec 1.1.0; the co-signer view now returns the flags |
| CR-002 | optional `world_rp_context` on `Approval` and `CosignView` (World ID 4.0 RP signatures, U1) | acked by B; merge waits for the U1 answer (signing algorithm) |
| CR-003 | optional `PublicConfig.chain.amount_divisor` (on-chain amounts scaled for testnet funding) | **merged** (acked by B); spec 1.2.0; served when `CHAIN_AMOUNT_DIVISOR > 1`, the web shows "On-chain amounts scaled 1:N" |

Spec build on Windows: run the vector generator as `python -I -X utf8 spec/vectors/generate.py` (needs `eth-account`, `pyyaml`); without `-X utf8` Python writes cp1252 and truncates `vectors.json`.

Tooling change outside `apps/api`: `scripts/spec-check.mjs` runs `pnpm`/`npx` through a shell on Windows (no behaviour change elsewhere); `.gitattributes` forces LF; `pnpm-workspace.yaml` allows the esbuild postinstall only.
