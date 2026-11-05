# AGENT_A.md - Backend + AI + data

You are **Agent A**. You build `apps/api` - the REST API, the evidence ledger, the deterministic scoring engine, the AI/agent layer (0G), and every blockchain transaction. A teammate's agent (**Agent B**) builds the contracts, the web app, ENS and the World client flows. You never edit their directories and they never edit yours.

**Read first, in order:** `INTEGRATION.md` -> `spec/openapi.yaml` -> `spec/ENGINE.md` -> `spec/HASHING.md` -> `spec/solidity/*.sol` -> `spec/fixtures/seed-scenario.json`. Then run `pnpm install && pnpm spec:check` and confirm it is green **before writing any code**.

Product rule you enforce in code: **agents collect, code computes, humans decide, chain proves.** No LLM output is ever a number that enters a score; no score is created without a human approval; nothing is paid without an attestation.

---

## 0. Hard rules (compatibility)

1. **The spec is the API.** Every route, field, enum, status code and error code comes from `spec/openapi.yaml`. Do not invent, rename or omit. Extra helper routes live under `/internal/*` only.
2. **Use `@proofwork/crypto`** for every hash, commitment, Merkle tree, subjectId, EIP-712 digest and signature recovery. Do not write another implementation. Do not call `JSON.stringify` for anything that is hashed - use `canonicalJson`.
3. **Use the generated types** from `@proofwork/shared` (`packages/shared/src/api.d.ts`) for handlers. Never hand-write DTO types.
4. **Contract guard (build this first):** a Fastify hook that (a) validates every request body/query against the openapi schema (reject unknown fields -> 400 `unknown_field`/`validation_failed`) and (b) in `NODE_ENV != production` validates every **response** against the openapi schema and throws on mismatch. This is what catches drift automatically. Load schemas with ajv 2020 using `{ $id:"pw", components }` exactly as `scripts/spec-check.mjs` does.
5. **Engine = port of `spec/reference/engine.mjs`** (copy to `apps/api/src/engine/`). It must stay pure: no I/O, no clock, no randomness, BigInt for money. `pnpm spec:check` plus your own test comparing against `vectors.json` and the `expect` blocks in `seed-scenario.json` must pass.
6. **Send `X-Spec-Version: 1.0.0`** on every response; `/healthz` returns `spec_version`.
7. **Defaults are mock.** `CHAIN_MODE`, `WORLD_MODE`, `ZEROG_MODE` default to `mock`. The system must work end to end with all three mocked (`pnpm dev` on a fresh clone).
8. **You are the only chain transaction sender.** Keys: `ANCHOR_PRIVATE_KEY`, `PAYOUT_PRIVATE_KEY`. Never expose them or send them anywhere. Browser code never sends transactions.
9. **Never log** raw claim text, salts, keys, tokens, World results, or evidence payloads. Log ids, hashes, codes.
10. If anything in the spec is wrong or missing, **file a CR** (CHANGE_REQUESTS.md) and work around it behind your adapter meanwhile. Do not silently diverge.

---

## 1. Stack (pinned - do not swap)

Node 22, TypeScript 5.6, **Fastify 5**, **better-sqlite3** (single file `data/proofwork.db`, WAL), ajv 2020 + ajv-formats, viem 2.21, `@proofwork/crypto`, `@proofwork/shared`, pino, vitest (unit + API integration via `fastify.inject`), jose (JWT HS256). AES-256-GCM via `node:crypto`. No ORM; plain SQL migrations in `apps/api/migrations/*.sql`. Package name **`@proofwork/api`** with scripts: `dev`, `build`, `test`, `seed:reset`, `e2e:demo`, `e2e:chain`.

```
apps/api/src/
  server.ts            fastify bootstrap, CORS (WEB_ORIGIN), helmet, body limit 100kb, rate limits
  config.ts            env parsing (zod) - names from .env.example
  contract/            openapi loader + ajv guard hooks
  auth/                dev login, JWT, ABAC policy (INTEGRATION 9)
  db/                  migrations, repo functions (no SQL outside db/)
  engine/              ported reference engine + evidence aggregation (pure)
  ledger/              evidence service: ingest, promotion rules, hash chain, commitments, encryption, shred
  claims/              draft, signing package, submit, cosign grants/view/sign/decline
  agent/               evidence agent orchestrator + connectors (mock data from seed-scenario)
  ai/                  InferenceClient (0g | mock), prompt-injection defences, JSON-schema output validation
  replica/             ReplicaStore (0g storage | local disk)
  world/               WorldVerifier (live | mock)
  chain/               ChainClient interface, MockChain (in-memory contract sim), ViemChain (live)
  scoring/             scorecards, diff, revise, carry-forward lookup, inputs_hash
  approvals/ payouts/ verify/ audit/
  dev/                 /v1/dev/* (enabled only when AUTH_MODE=dev)
apps/api/test/         unit + integration + e2e (see section 7)
```

---

## 2. Data model (SQLite)

All timestamps ISO strings UTC. Money TEXT (decimal). Use `STRICT` tables.

| Table | Key columns |
|---|---|
| `org_employees`, `org_personas`, `org_cycles`, `org_plans` | loaded from `spec/fixtures/*` by `seed:reset` (plans stored as the exact JSON) |
| `claims` | claim_id, employee_id, cycle_id, kra_id, state, body_json, excerpt, cosigner_address, cosigner_label, ai_flags_json, inference_json, claim_commitment, evidence_commitment, nonce, deadline, employee_sig, cosigner_sig, evidence_id, decline_reason, created_at, updated_at |
| `claim_secrets` | claim_id, claim_salt_enc, evidence_salt_enc (AES-GCM under the record DEK) |
| `cosign_grants` | grant_id, claim_id, auth_method, token_sha256, expires_at, closed_at, closed_reason |
| `evidence` | evidence_id, employee_id, cycle_id, source, kind, ref, status, observed_at, observations_json, severity, self_introduced, share_bps, reverts_evidence_id, supersedes_evidence_id, claim_id, commitment, batch_id, seq (global, monotonic), prev_hash, event_hash, shredded_at; UNIQUE(source, kind, ref) for idempotent ingest |
| `evidence_secrets` | evidence_id, salt_enc, payload_enc (raw connector payload), dek_wrapped, replica_root, replica_status |
| `runs`, `run_tool_calls` | run_id, employee_id, cycle_id, status, evidence_ids_json, inference_json, agent_json, error |
| `scorecards` | scorecard_id, employee_id, cycle_id, version, supersedes_id, reason, status, result_json, evidence_ids_json, evidence_root, score_commitment, score_salt_enc, subject_id, approval_id, attestation_json |
| `approvals` | approval_id, scorecard_id, status, challenge, world_action, approver_employee_id, comment, proof_hash, world_result_hash, created_at, decided_at |
| `world_nullifiers` | nullifier PRIMARY KEY, context (action), used_at - replay protection |
| `batches`, `batch_items` | batch_id, numeric_id (monotonic), root, count, tx_hash, anchored_at; (batch_id, evidence_id, leaf_index) |
| `attestations` | attestation_id (on-chain id), scorecard_id, version, supersedes_id, tx_hash, attested_at |
| `payouts` | scorecard_id, status, entitlement, paid, held, forfeited, overpaid, maturity_at, last_tx |
| `audit_log` | seq, at, actor, action, subject, detail_json, prev_hash, event_hash (hash chain via `eventHash`) |
| `idempotency` | key, route, response_json |

**Encryption:** one random 32-byte DEK per evidence/claim record, AES-256-GCM; DEK wrapped under `DATA_KEY`. **Shred = delete the wrapped DEK + payload + salt + replica pointer** - commitment and Merkle leaf remain.

---

## 3. Algorithms you must get exactly right

**3.1 Evidence ingest** (`/v1/evidence/ingest`, runs, dev inject, claim submit):
`salt = randomSalt()`; `core = {source, kind, ref, observed_at, observations, severity|null, self_introduced:false default, share_bps:10000 default}`; `commitment = commit(salt, core)`; `event_hash = eventHash(prevEventHash, {seq, evidence_id, commitment, status})`. Promotion: connector sources (`github|tickets|crm|hris`) -> `verified`; everything else -> `unverified`. Duplicate `(source,kind,ref)` returns the existing item (HTTP 201 with same body, no new row). `reverts_ref` -> mark target `reverted`, link both, audit-log it, set `needs_revision:true` on every attested/approved scorecard that used the target (field exists on `Scorecard`; do NOT auto-create v2 - a human triggers `/revise`). Reject observations with non-integers (`validation_failed`). Severity set by the fixer themself -> store flag, keep `unverified` (negative test n17).

**3.2 Compute (`/v1/scores/compute`, scorecards):** load plan + all evidence for (employee, cycle) with `as_of` filter on `observed_at`; run `evaluatePlan`/`evaluateCommission` from the engine; carry-forward: look up the **latest non-revoked scorecard of the previous cycle** for that employee (`status in attested|approved`); `inputs_hash` per HASHING.md section 4. `override_actuals` only in compute, never persisted into scorecards. Identical input -> identical bytes (n11).

**3.3 Scorecard create/revise:** next version = max+1. Status `draft`. `evidence_root = buildMerkle(commitments of counted evidence).root` (no counted evidence -> 422 `validation_failed`, "no verified evidence"). `score_commitment = scoreCommitment(salt, scoreObject)` with the object defined in HASHING.md section 4 (subject pseudonym, never a name). Revision records `reason`, links `supersedes_scorecard_id`. `diff` compares `lines[].actual`, contributions, evidence id sets, and `bonus_amount` deltas.

**3.4 Approvals:** `challenge = keccak256(canonicalJson({scorecard_id, score_commitment, nonce}))`, `world_action = "pw-approve-scorecard"` (+ scorecard id). Approver must be `manager` of the employee or `hr`, never the employee (403 n01). `approve` requires a valid `world_result` -> `WorldVerifier.verify({action, signal: challenge, result})`; on failure 401 `world_verification_failed` and approval stays `pending`; `deny` is final (status `denied`, scorecard `denied`). `approval_proof_hash` per HASHING.md section 4. Store only the **hash** of `world_result`, never the raw proof. Nullifier reuse -> reject (n04).

**3.5 Anchor:** collect evidence with `batch_id IS NULL` and `status != shredded|rejected`; `buildMerkle(commitments)`; `batchId = last numeric_id + 1`; `chain.anchorBatch(root, batchId, count)`; persist items with proofs. Empty set -> 409 `conflict`.

**3.6 Attest:** requires scorecard `approved` and its approval `approved` (else 409 `approval_required` / `approval_denied`). Ensure the scorecard's evidence is anchored (anchor first if not). Compute `supersedes` = on-chain id of the previous non-revoked attestation for the same (subject, cycle) or 0. Call `registry.attestScore(...)`; read the new id from the `ScoreAttested` event; first time per (subject, cycle) call `vault.registerPlan(subjectId, cycleNumericId, payee=employee wallet, targetBonus, holdbackBps, maturitySeconds = maturity_days*86400)`. Mark previous scorecard `superseded`, evidence `verified -> provisional`. If supersedes != 0 and a payout exists, call `vault.applyRevision(old, new)` and store the result.

**3.7 Payout read-model:** after every vault call, read `vault.getPayout(subjectId, cycleId)` and store; the API always returns chain truth (mock chain = same code path). For `tiered_commission` plans `targetBonus` = `bonus_amount` from the compute result and `multiplier=10000`.

**3.8 Verify:** per openapi `VerifyResult.checks`: recompute commitment from the supplied reveal; Merkle proof vs the on-chain `batchRoot`; attestation not revoked; for claims both EIP-712 signers via `recoverClaimSigner` against the stored addresses; hash chain intact from the stored events; formula hash equals the plan's; shredded evidence reports `evidence_not_shredded:false` while `merkle_proof_valid` stays true.

**3.9 Cosign grants:** token = 32 random bytes base64url; store only `sha256`. Single claim, TTL (default 72h, max 168h). Closed on sign/decline/expiry/revoke -> every later call is 410 `grant_closed`. `GET /v1/cosign/view` returns **the minimum** needed (body, excerpt, typed data, AI flags) - no employee id, no other claims, no scores. Constant-time token comparison. A World-id grant requires `world_result` on sign (action = `pw-cosign-claim`, signal = claim digest).

**3.10 Signing package:** build `typed_data` with domain from config (`chain_id`, `registry` address as `verifyingContract`), `nonce` = random uint < 2^53, `deadline` = now+72h unix. Freeze the draft (later PATCH -> 409 `invalid_state`, n08). Return `digest = claimDigest(...)` so clients can double check.

---

## 4. AI layer (0G Private Computer) and the evidence agent

**InferenceClient (live):** `POST {ZEROG_BASE_URL}/chat/completions` (OpenAI-compatible) with headers `Authorization: Bearer ZEROG_API_KEY`, `X-0G-Provider-Trust-Mode: private`, body field `verify_tee: true`. Record in `InferenceRecord`: provider, model, request id (`X-Request-ID`), `ZG-Res-Key`, `tee_verified` from the response trace, `prompt_hash`/`output_hash` (keccak of the strings). **These details come from sponsor docs and were not independently re-verified - test on Friday morning; if the call fails or the credits are on another environment (U2), flip to mock and keep going.** Mock: deterministic extraction (regex for dates, minutes, counterparty), `provider:"mock"`, `tee_verified:null`, and the UI shows a MOCK badge.

**Draft step contract:** the LLM may only fill `kind`, `summary`, `occurred_on`, `duration_minutes`, `counterparty_label`. Your code sets `kra_id`, `cycle_id`, `cosigner`, `state`. Validate the LLM output against `ClaimBody` with ajv; clamp lengths; `occurred_on` must lie inside the cycle (else set `low_confidence` flag and use the earliest allowed date); retry once on schema failure then fall back to a literal summary (first 300 chars of the cleaned text) and flag `fields_inferred`.

**Prompt-injection defences (demo case c2):** (1) system prompt states the user text is untrusted data and gives a fixed JSON schema; (2) user text wrapped in a delimiter and never concatenated into instructions; (3) heuristic detector (patterns like "ignore previous", "system prompt", "set my score", "approve", "mark as verified", markdown/HTML tool-call lookalikes) sets `ai_flags += prompt_injection_suspected` regardless of the LLM; (4) no tools are available in the draft call; (5) nothing the LLM returns can change state, score, approvals or addresses. A flagged claim still proceeds but the flag is shown to the co-signer and manager.

**Evidence agent (`POST /v1/runs`):** an orchestrator that calls five tools - `git`, `tickets`, `crm`, `hris`, `worklog` - for one employee+cycle. The tools are **deterministic connectors**; in demo they read from `spec/fixtures/seed-scenario.json` events (using `spec/reference/expand.mjs`) filtered by employee/cycle. The LLM (if live) may choose the order of tool calls and write a summary note, but **numbers in evidence come only from tool return values written by your code**, never from model text. Record each tool call in `tool_calls`. Set `agent_identity.ens_name` = `AGENT_ENS_NAME` from config and `agent_pass` = `verified|mock|unverified` per the `WorldVerifier` agent-attestation check (stretch; default `mock`). The run is async: return 202 immediately, finish in the background, poll via `GET /v1/runs/{id}`.

**ReplicaStore:** after commit, store the encrypted payload (`payload_enc`) on 0G Storage and save `replica_root`; `replica.status` in `EvidenceItem` goes `pending -> stored|failed`. Mock = write to `data/replica/<root>.bin`. A failed replica never blocks the flow. This is the "availability" mitigation: org DB is primary, 0G is the encrypted copy.

---

## 5. Chain layer

```ts
interface ChainClient {
  mode: "mock" | "live";
  anchorBatch(root: Hex, batchId: bigint, count: number): Promise<{ txHash: Hex }>;
  attestScore(a: AttestArgs): Promise<{ txHash: Hex; attestationId: bigint }>;
  revoke(id: bigint, reasonHash: Hex): Promise<{ txHash: Hex }>;
  registerPlan(a: RegisterArgs): Promise<{ txHash: Hex }>;
  release(attId: bigint): Promise<{ txHash: Hex }>;
  releaseHoldback(attId: bigint): Promise<{ txHash: Hex }>;
  dispute(attId: bigint, reasonHash: Hex): Promise<{ txHash: Hex }>;
  resolveDispute(attId: bigint, release: boolean): Promise<{ txHash: Hex }>;
  applyRevision(oldId: bigint, newId: bigint): Promise<{ txHash: Hex }>;
  getAttestation(id: bigint): Promise<Attestation>;
  getPayout(subjectId: Hex, cycleId: bigint): Promise<PayoutState>;
  batchRoot(batchId: bigint): Promise<Hex>;
  latestAttestation(subjectId: Hex, cycleId: bigint): Promise<bigint>;
}
```
- **MockChain** simulates both contracts in memory (and persists to SQLite) with the same revert rules as the interface docs and the **exact** `payout_split` / `revision` math from `spec/reference/engine.mjs`. Tx hashes = `keccak(canonicalJson({op, args, n}))`.
- **ViemChain** uses `spec/abi/*.json` for the typed calls and `deployments/arc.json` + env for addresses; wait for receipts; parse events; retry nonce errors once; surface contract reverts as 502 `chain_error` with `details.revert`.
- One test-suite runs against **both** implementations (`chain.contract.test.ts`); live run is `pnpm e2e:chain`.
- Read `chain` and `contracts` in `/v1/config/public` from env (`CHAIN_ID`, `RPC_URL`, `*_ADDRESS`). `eip712_domain.verifyingContract` = registry address.

---

## 6. Work plan (about 35-37 hours; times IST; gates from INTEGRATION 10)

**Block 0 - Fri 01:00-03:00 (2h) - with Agent B**
- [ ] Pull repo, `pnpm install`, `pnpm spec:check` green.
- [ ] Scaffold `apps/api` (name `@proofwork/api`), Fastify, `/healthz`, config, contract guard, pino.
- [ ] Generate two keypairs (anchor, payout) -> put in `apps/api/.env`, **message the addresses to Agent B**.
- [ ] Confirm with Agent B: API port 8787, `WEB_ORIGIN`, who runs Prism (B).
- [ ] Ask U1/U2/U3 questions to sponsor mentors when they open (Fri AM).

**Block 1 - Fri 09:00-14:00 (5h) -> Gate G1**
- [ ] Migrations; `seed:reset` loads `spec/fixtures` (plans, org, cycles).
- [ ] Auth: `/v1/dev/login`, `/v1/me`, ABAC policy middleware + tests (matrix in INTEGRATION 9).
- [ ] `/v1/config/public` (mock addresses from `.env.example`), org/plans/cycles/employees.
- [ ] Ledger: ingest + promotion + hash chain + commitments + encryption + idempotency.
- [ ] Engine port + `scores/compute` + tests vs `vectors.json` and every `expect` in `seed-scenario.json`.
- [ ] Claims F1 end to end with MockChain-free path: create (mock AI + injection detector), edit, signing-package, submit (recover signer), cosign grants/view/sign/decline/closed-410.
- [ ] Audit log hash chain + `/v1/audit`.
- **G1 proof:** `pnpm --filter @proofwork/api test` green; contract guard has caught zero schema mismatches; Agent B can log in and create a claim against the real server.

**Block 2 - Fri 15:00-22:00 (7h) -> Gate G2**
- [ ] Scorecards (create/revise/diff/list), evidence root, score commitment, carry-forward lookup.
- [ ] Approvals + `WorldVerifier` (mock) + nullifier replay table; deny path blocks attest.
- [ ] `ChainClient` interface + MockChain; anchor, attest, payouts (release, holdback, dispute, resolve), `applyRevision`; payout read-model.
- [ ] Runs + evidence agent with seed-scenario connectors; `/v1/dev/inject`.
- [ ] `/v1/verify`, shred.
- [ ] `e2e:demo` v0 (API-only script: s1 -> compute -> scorecard -> approve (mock World) -> anchor -> attest -> release -> s3 revert -> revise -> approve -> attest -> applyRevision -> s4).
- [ ] When B reports contracts deployed: set `.env` from `deployments/arc.json`, `CHAIN_MODE=live`, run `pnpm e2e:chain`. Fix integration issues with B before sleeping.
- **G2 proof:** `pnpm e2e:chain` succeeds on Arc testnet (anchor + attest + registerPlan + release).

**Block 3 - Sat 06:00-13:00 (7h) -> Gate G3**
- [ ] ViemChain hardening; run `chain.contract.test.ts` against live.
- [ ] Live InferenceClient (0G) + trace in `InferenceRecord`; ReplicaStore on 0G Storage + fallback.
- [ ] Live WorldVerifier per U1 answer (Agent Pass first, IDKit second); keep mock available.
- [ ] Idempotency-Key support, rate limits, request-size limits, security headers, CORS lock-down.
- [ ] Carry-forward edge cases (no prior cycle, prior revoked, prior superseded), open-items list.
- **G3 proof:** `pnpm e2e:demo` green including revert -> v2 -> clawback numbers equal to `revision_cases` math and to `seed-scenario` expectations.

**Block 4 - Sat 14:00-20:00 (6h) -> Gate G4 (feature freeze 20:00)**
- [ ] Implement and automate negative tests **n01-n18** (`test/negative.test.ts`).
- [ ] Performance sanity: a full demo run < 30 s with mocks.
- [ ] Bug bash with Agent B's UI; fix API-side issues only.

**Block 5 - Sat 20:00-Sun 02:00 (6h) -> Gate G5**
- [ ] No new features. Fix bugs, improve error messages, make `seed:reset` one command, write `docs/api-notes.md` (what is real vs mock, known limits).
- [ ] Support the demo video: provide a `pnpm --filter @proofwork/api demo:script` that prints the exact click order and ids.

**Block 6 - Sun 06:00-07:30 -> Gate G6**
- [ ] Final `spec:check`, tests, tag `submission`, confirm `.env.example` complete, no secrets in git (`git log -p | grep -i key`).

---

## 7. Tests you own

| Suite | What it proves |
|---|---|
| `engine.vectors.test.ts` | engine == `vectors.json` (all case groups) |
| `engine.seed.test.ts` | for each step in `seed-scenario.json`, compute equals `expect` |
| `contract.guard.test.ts` | every route's example response validates against openapi |
| `claims.flow.test.ts` | F1 including wrong signer (n06), wrong chain (n07), tamper (n08), reuse (n05), decline |
| `approvals.test.ts` | n01-n04, deny blocks attest (n02) |
| `ledger.test.ts` | idempotent ingest (n12), floats rejected (n13), gate (n10), unverified not counted (n09), hash chain |
| `chain.contract.test.ts` | MockChain and ViemChain behave identically incl. revision math |
| `verify.test.ts` | happy path, tampered reveal, shred (n15) |
| `negative.test.ts` | n01-n18 end to end |
| `e2e:demo` | full story s1 -> s4 + scripted claims c1-c3 |

---

## 8. Things you must NOT do

- Touch `contracts/`, `apps/web/`, `spec/` (except through a CR).
- Compute any score with floats, `Date.now()` in the engine, or LLM output.
- Count `unverified` evidence in a score.
- Let the web app (or anyone) trigger a payout without an attestation, or an attestation without an approved approval.
- Return the co-signer anything beyond the claim they are asked to sign.
- Store raw World proofs, raw claim text in logs, or private keys in the repo.
- Claim "GDPR compliant" or "ZK-proven" anywhere. ZK is roadmap only.

---

## 9. Definition of done

`pnpm install && pnpm --filter @proofwork/api seed:reset && pnpm dev` serves the full spec on :8787 with mocks; `pnpm spec:check`, `pnpm --filter @proofwork/api test`, `pnpm e2e:demo` are green; with `CHAIN_MODE=live` `pnpm e2e:chain` is green; negative tests n01-n18 pass; `docs/api-notes.md` states honestly which adapters ran live in the final demo.
