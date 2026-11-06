# INTEGRATION.md - how Agent A and Agent B stay compatible

Spec version **1.2.0** (1.0.0 + CR-001, CR-003). This file is FROZEN with `spec/`. Both agents read it fully before writing code. If this file and an agent file disagree, **this file wins**. If this file and `spec/` disagree, **`spec/` wins** (and file a CR to fix this file).

Precedence: `spec/` (openapi, ABIs, vectors, HASHING, ENGINE, eip712) > `INTEGRATION.md` > `AGENT_A.md` / `AGENT_B.md` > code.

Product in one line: **agents collect, code computes, humans decide, chain proves.**

---

## 1. Who builds what

| | **Agent A - Backend + AI + data** | **Agent B - Contracts + Frontend + identity** |
|---|---|---|
| Owns | `apps/api/**` | `contracts/**`, `apps/web/**`, `deployments/**`, `docs/diagrams/**`, final `README.md`, demo video script |
| Implements | REST API (the whole `spec/openapi.yaml`), evidence ledger, salted commitments + encryption, connectors, deterministic engine, 0G inference + storage replica, co-sign service, Merkle anchoring, **all chain transactions** (viem), World server-side verifier | `IAttestationRegistry` + `IBonusVault` (Arc Studio), ENS, World client flows (Agent Pass / IDKit), EIP-712 signing UI, every screen, ABI export, demo orchestration page |
| Sponsor surface | 0G (Private Computer + Storage), World (server verification) | Arc/Circle, ENS, World (client), presentation of all four |
| Never touches | `contracts/`, `apps/web/` | `apps/api/` |
| Shared, read-only | `spec/`, `packages/crypto`, `packages/shared` (generated) - change only through `CHANGE_REQUESTS.md` | same |

**Dependency direction (one way, no cycles):** `spec` -> both. Agent B consumes A's HTTP API and A consumes B's deployed contract addresses/ABIs. Nothing else crosses.

### 1.1 Repo layout
```
spec/                  frozen contract (openapi.yaml, abi/, solidity/, vectors/, fixtures/, reference/, HASHING.md, ENGINE.md, eip712.json, VERSION)
packages/crypto/       the ONLY hashing/commitment/Merkle/EIP-712 implementation (TS)
packages/shared/       GENERATED API types (pnpm gen:types) - never hand-edit
apps/api/              Agent A
apps/web/              Agent B
contracts/             Agent B (Arc Studio export + local tests)
deployments/arc.json   Agent B writes after deploying; Agent A reads (schema in section 7)
scripts/               spec-check.mjs, check-abi.mjs, compile-abi.mjs, gen-fixtures.mjs
docs/                  diagrams + notes
```

---

## 2. Frozen vs flexible

**Frozen (CR required to change):** every path/field/enum in `openapi.yaml`; both Solidity interfaces + ABIs; the EIP-712 struct and domain; all constructions in HASHING.md; all formulas in ENGINE.md; plan/seed fixtures; env var names in `.env.example`; ports.

**Free (your call, no coordination):** internal module structure, DB engine details, UI design, component libraries, extra *internal* helper endpoints under `/internal/*` (not in spec, not used by the other agent), extra contract functions/events *beyond* the interface (ABI superset is allowed and checked), private storage layouts.

### 2.1 Change-request process (kept short on purpose)
1. Append a CR to `CHANGE_REQUESTS.md` (template inside). Status `proposed`.
2. **Additive** change (new optional field, new endpoint, new enum value the other side can ignore): the other agent replies `ack` or `object` within 30 minutes of working time; no reply = ack. Proposer merges.
3. **Breaking** change (rename, remove, type change, required-field add, formula change): needs explicit `ack` from the other agent. Prefer an additive alternative first.
4. Merger bumps `spec/VERSION` (minor for additive, major for breaking), runs `pnpm spec:build && pnpm spec:check`, commits **spec + regenerated files in one commit**, and tells the other agent to pull.
5. Never edit generated files by hand: `packages/shared/src/api.d.ts`, `spec/abi/*.json`, `spec/vectors/vectors.json`, `spec/fixtures/plans/*`, `seed-*.json`.

### 2.2 The pre-push gate (both agents, every push)
```
pnpm install --frozen-lockfile
pnpm spec:check      # openapi valid, fixtures valid, vectors == JS ref == TS crypto, ABIs, types current
```
Agent A also runs `pnpm --filter @proofwork/api test`; Agent B also runs `pnpm --filter @proofwork/web build` and `pnpm check:abi` (section 7). **A red `spec:check` blocks merging.** Both machines must run the same Node (22.x) and pnpm (10.x).

---

## 3. Environment, ports, toolchain

| Item | Value |
|---|---|
| Node | 22.x (`engines` enforced) |
| Package manager | pnpm 10.x (workspace) |
| TypeScript | 5.6.x |
| viem | 2.21.x (**both** apps, same version - EIP-712 behaviour must match) |
| Solidity | `^0.8.0` interfaces; implementation compiler = whatever Arc Studio offers (>= 0.8.19 recommended) |
| API | `http://localhost:8787` |
| Web | `http://localhost:3000` (API CORS allows it; `WEB_ORIGIN` env overrides) |
| Time | UTC everywhere; the engine never reads the clock (pass `as_of`) |

Env ownership: Agent A owns `apps/api/.env`; Agent B owns `apps/web/.env.local`. The union of variable names is in `.env.example` (frozen names). Secrets (role private keys, ORG_SECRET, JWT_SECRET, 0G key) **never** go in git; testnet keys only.

---

## 4. Mock / live adapters - the system must always be demoable

Every external dependency sits behind an adapter with a `mock` mode that is the **default**. Flipping one mode never requires changes on the other side.

| Switch | Owner of adapter | `mock` behaviour | `live` behaviour | Reported at |
|---|---|---|---|---|
| `CHAIN_MODE` | A (`ChainClient`) | in-process ledger implementing both interfaces, returns fake tx hashes `0x..` derived from inputs, same revert rules | viem against deployed Arc contracts using role keys | `GET /v1/config/public` `chain_mode` |
| `WORLD_MODE` | A (`WorldVerifier`) | accepts `world_result` with `adapter:"mock"` whose `payload.action` and `payload.signal` equal the server's expected values and whose `payload.nullifier` is unused | validates the real proof server-side (Agent Pass / IDKit verify API) | `world_mode` |
| `ZEROG_MODE` | A (`InferenceClient`, `ReplicaStore`) | deterministic fake extraction from `raw_text`; replica stored on local disk | 0G Private Computer chat completion (`X-0G-Provider-Trust-Mode: private`, `verify_tee`) + encrypted blob to 0G Storage | `zerog_mode` |
| `ENS_NETWORK` | B (web only) | names shown from the seed (`ens_name`), no lookups | viem ENS reads (Sepolia / mainnet) | `ens.network` |

A UI must show a small **MOCK** badge whenever a mode is `mock` (Agent B reads the config). Judges must be able to see what is real. Never present a mock proof as verified.

---

## 5. Conventions (violating any of these breaks the other side)

1. **Money:** decimal string of base units. USDC = 6 decimals. Never a JSON number, never a float. Clients use `BigInt`.
2. **Scores:** integers - `score_ppm`, `*_bps`, milli-points. Display formatting only (`bps/100 = %`) in the UI, never feed back into logic.
3. **uint64/uint256 in typed data:** JSON integers < 2^53 (`cycleId`, `nonce`, `deadline`); convert with `toClaimMessage()` from `@proofwork/crypto`.
4. **IDs:** opaque strings with prefix (`clm_`, `evd_`, `scd_`...). The UI never parses them.
5. **Errors:** always `{ error: { code, message, details? } }` with `code` from the enum in openapi. The UI maps `code` -> message; the table is in AGENT_B.md.
6. **Auth:** `Authorization: Bearer <jwt>` for app users; `X-Cosign-Token` for the co-signer; `X-Connector-Key` for connectors. Web stores the JWT in memory + `sessionStorage` only.
7. **Unknown fields:** server rejects them (`unknown_field`); client must not send extras. Server may *add* optional response fields in minor versions - clients ignore unknown response fields.
8. **Idempotency:** creating POSTs accept `Idempotency-Key`; Agent B sends one per user action to survive double clicks.
9. **Spec handshake:** API sends header `X-Spec-Version: 1.2.0` on every response and `/healthz.spec_version`. The web app compares the **major** with its compiled-in constant and shows a blocking banner on mismatch.
10. **Hex case:** hashes lowercase; addresses EIP-55 checksummed in API output; accept either on input (server normalises).
11. **Pagination:** list endpoints return `{items}` (no pagination in v1; demo data is small).
12. **Co-signer URL:** `/cosign#token=<token>` - the token lives in the **fragment** so it never reaches server logs; the web app moves it to memory and sends it as `X-Cosign-Token`.

---

## 6. The flows (the contract in motion)

Legend: **A** = API/server work, **B** = web/contract work, `->` = HTTP call.

### F1 - Claim -> co-sign (the "I did this" path)
1. B: employee types free text -> `POST /v1/claims` {cycle_id, kra_id, raw_text, cosigner_address, cosigner_label}.
2. A: AI draft (0G, or mock) -> `Claim` in `drafted` with `body`, `evidence_excerpt`, `ai_flags`, `inference` (tee_verified, request_id). Untrusted text is data, never instructions.
3. B: shows draft; employee edits (`PATCH /v1/claims/{id}/draft`) or accepts.
4. B -> `GET /v1/claims/{id}/signing-package` (A freezes the draft, generates salts, computes `claim_commitment`/`evidence_commitment` with `@proofwork/crypto`, returns `typed_data`, `digest`, values and salts).
5. B: **verify locally** - recompute both commitments and the digest with `@proofwork/crypto`; refuse to sign on mismatch (this is the anti-"blind signing" check and a demo highlight). Then `signTypedData` -> `POST /v1/claims/{id}/submit`.
6. A: recovers the signer == employee wallet, state `pending_cosign`; creates the claim's `EvidenceItem` (`source:cosign`, `kind:client_cosign`) as **`unverified`** (not counted, lowers `verified_ratio` honestly while pending).
7. B -> `POST /v1/claims/{id}/cosign-grants` {auth_method} -> `CosignGrant` (`url`, `token` once). Dev: link returned, shown in a modal ("email" simulated).
8. B (co-signer page `/cosign`): `GET /v1/cosign/view` (header token). Shows claim + excerpt + AI flags + employee signature. `auth_method=world_id` -> B runs the World flow bound to `world_action`; `magic_link_wallet` -> wallet connect.
9. B signs the **same** typed data -> `POST /v1/cosign/sign` {signature, world_result?}. A verifies signer == `claim.cosigner_address`; if `world_id`, `WorldVerifier` validates. Claim -> `verified`; its `EvidenceItem` becomes `verified`; **the grant is closed**: later `GET /v1/cosign/view` -> 410 `grant_closed` (the co-signer loses access). Decline -> `POST /v1/cosign/decline` -> `declined`, evidence `rejected`. Grant expiry -> claim `expired`, evidence `rejected`.

### F2 - Collect -> score -> approve -> attest -> pay
1. `POST /v1/runs` (or connector webhooks `POST /v1/evidence/ingest`). A's agent calls tools (git/tickets/crm/hris/worklog) and writes `unverified`/`verified` evidence per ENGINE.md promotion rules.
2. `POST /v1/scorecards` {employee_id, cycle_id} -> A runs the **pure** engine over counted evidence -> `Scorecard` v1 `draft` (with `result`, `evidence_root`, `score_commitment`).
3. `POST /v1/approvals` {scorecard_id} -> `Approval` {challenge, world_action}. B runs the **World step-up** bound to `world_action` (signal = `challenge`) in the manager's session and posts `POST /v1/approvals/{id}/complete` {decision, world_result}. A validates server-side. **deny** or invalid proof -> scorecard `denied`; `POST /v1/chain/attest` returns 409 `approval_required`; payout is impossible.
4. `POST /v1/chain/anchor` (Merkle root of new evidence commitments -> `registry.anchorBatch`), then `POST /v1/chain/attest` {scorecard_id} -> `registry.attestScore(...)` (+ `vault.registerPlan` on first attest) -> `AttestationRef`.
5. `POST /v1/payouts/{scorecard_id}/release` -> `vault.release(attestationId)` pays `entitlement x (1 - holdback)`; later `.../release-holdback` after maturity. B shows `Payout`.

### F3 - Revert -> revised score (the "bad merge" path)
1. Connector (or `POST /v1/dev/inject {step_id:"s3_revert_pr"}`) delivers `pr_reverted` with `reverts_ref`. A sets the original evidence `reverted`.
2. `POST /v1/scorecards/{v1}/revise` {reason} -> v2 `draft` with `supersedes_scorecard_id`; B shows `GET /v1/scorecards/{v2}/diff/{v1}`.
3. Approve v2 (F2.3) -> attest: `registry.attestScore(..., supersedes=v1Attestation)` revokes v1; A then calls `vault.applyRevision(old, new)`; `Payout` shows `forfeited` / `overpaid` / `extra_owed` per ENGINE.md `revision`.

### F4 - Verify later (selective disclosure, no ZK in v1)
`POST /v1/verify` {kind, id, reveal:{value,salt}} (public, no auth) recomputes the commitment, checks the Merkle proof against the on-chain root, checks attestation not revoked, recovers both EIP-712 signers (claims). B renders the `checks[]` list. **Honest limit shown in the UI:** if the raw data is lost, hashes cannot recreate it; org DB + encrypted 0G replica exist for that.

### F5 - Erasure
HR: `POST /v1/evidence/{id}/shred` -> A destroys the per-record data key, deletes plaintext and the replica pointer; commitment and Merkle leaf remain. `verify` then reports `evidence_not_shredded:false` and `merkle_proof_valid:true`. Say "designed for erasure via crypto-shredding", never "GDPR compliant".

---

## 7. Chain interface (A calls, B implements)

| Backend operation | Contract call | Caller key | Notes |
|---|---|---|---|
| anchor batch | `registry.anchorBatch(root, batchId, count)` | `ANCHOR_PRIVATE_KEY` (ANCHOR_ROLE) | batchId = A's monotonic counter; must be unused |
| attest | `registry.attestScore(subjectId, cycleId(numeric), version, scoreCommitment, evidenceRoot, formulaHash, approvalProofHash, multiplierBps, supersedes)` | `ANCHOR_PRIVATE_KEY` (ATTESTER_ROLE) | returns id via `ScoreAttested` event; supersede revokes the old one atomically |
| register plan | `vault.registerPlan(subjectId, cycleId, payee, targetBonus, holdbackBps, maturitySeconds)` | `PAYOUT_PRIVATE_KEY` (PLANNER_ROLE) | once per (subject,cycle) |
| release | `vault.release(attestationId)` | PAYOUT | must revert if attestation revoked / mismatch |
| holdback | `vault.releaseHoldback(attestationId)` | PAYOUT | after maturity, not disputed |
| dispute / resolve | `vault.dispute`, `vault.resolveDispute` | DISPUTER / RESOLVER | |
| revision | `vault.applyRevision(old, new)` | PAYOUT | math == ENGINE.md `revision` |
| fund cycle | `vault.fundCycle(cycleId, amount)` | **Agent B script** (`contracts/scripts/fund`) | needs ERC-20 `approve` first; not an API endpoint |

Rules:
- The **backend is the only transaction sender** for the app. The browser never sends a chain transaction (it only signs EIP-712 messages). Keys for roles live only in `apps/api/.env`.
- Role constants are **read from the contract** (`ANCHOR_ROLE()` etc.), never hard-coded. Agent A generates two keypairs at G0 and gives Agent B the **addresses**; B's deploy script grants the roles.
- `cycleId` on chain is `Cycle.numeric_id`; `subjectId` per `HASHING.md`. Vault amounts are base units of `asset()`; the vault must `require(decimals() == 6)`.
- Conformance: Studio's exported ABI must be a superset of `spec/abi/*.json`. `deployments/arc.json` schema:
```json
{
  "network": "arc-testnet",
  "chainId": 0,
  "rpcUrl": "",
  "explorerBaseUrl": "",
  "studioUrl": "",
  "registry": "0x...", "vault": "0x...", "asset": "0x...",
  "registryAbiFile": "deployments/abi/AttestationRegistry.json",
  "vaultAbiFile": "deployments/abi/BonusVault.json",
  "roleHolders": { "anchor": "0x...", "payout": "0x..." },
  "deployedAt": "2026-11-06T00:00:00Z"
}
```
`pnpm spec:check` verifies the ABI files named there if the file exists. Agent A copies the values into `.env` (`CHAIN_ID`, `RPC_URL`, `REGISTRY_ADDRESS`, ...). The web reads them from `/v1/config/public` only - never from its own env.

---

## 8. World contract (the part most likely to shift)

The exact Agent Pass call sequence was not confirmable from public docs at spec time. Therefore:
- `WorldResult` is **opaque** `{ adapter: "agent_pass"|"idkit"|"mock", payload: {...} }`. Agent B posts whatever the SDK returned, unchanged. Agent A's `WorldVerifier` is the only code that interprets it.
- Every World interaction is bound to an **action string** and **signal** that A issues: approvals use `Approval.world_action` + `Approval.challenge`; co-sign uses `CosignView.world_action` + the claim digest. A rejects a proof whose action/signal differ, and rejects a reused nullifier (replay) -> `world_verification_failed`.
- Mock payload shape (what B's "Mock World" button must produce when `world_mode=mock`): `{ adapter:"mock", payload:{ action, signal, nullifier:"0x"+64 random hex } }`.
- Roles still come from SSO/JWT + policy. **World proves a human, not a role.**
- If the live flow changes the payload, only `WorldVerifier` (A) and the World client wrapper (B) change; neither requires a spec change. A CR is needed only if the endpoints' *shape* must change.

---

## 9. Permission matrix (ABAC, enforced by A, mirrored by B for UX only)

| Action | employee (self) | manager of employee | hr | external cosigner | public |
|---|---|---|---|---|---|
| view own evidence/claims/scorecards | yes | - | - | - | - |
| view reports' evidence/scorecards | no | yes | yes (all) | no | no |
| create claim / sign as employee | self only | no | no | no | no |
| view claim + sign as cosigner | no | no | no | only with a live grant for that claim | no |
| create/complete approval | no (never own) | yes (+ World step-up) | yes | no | no |
| attest, anchor, payouts | no | via backend after approval | via backend | no | no |
| shred evidence | no | no | yes | no | no |
| `/v1/verify`, `/healthz`, `/v1/config/public` | yes | yes | yes | yes | yes |

Cross-user access to a resource must return **404** (not 403) to avoid ID probing, except explicit `forbidden` for role violations on known resources (e.g. n01).

---

## 10. Handoff gates (hard checkpoints; each has a command that proves it)

| Gate | When (IST) | Agent A delivers | Agent B delivers | Proof |
|---|---|---|---|---|
| **G0** | Fri 03:00 | repo cloned, `pnpm install`, `spec:check` green, API skeleton on :8787 returning `/healthz`, **role key addresses** | Arc Studio project created, web skeleton on :3000, Prism mock wired (`pnpm mock:api`) | both run `pnpm spec:check` |
| **G1** | Fri 14:00 | contract-conformant API with fixtures: login, org, plans, claims (mock AI), signing-package, submit, cosign, ingest, compute - `CHAIN_MODE=mock` | both contracts **compile** in Studio; ABI exported; `pnpm check:abi` green; web: login + dashboard + claim form against A's server | A: `pnpm --filter @proofwork/api test`; B: `pnpm check:abi` |
| **G2** | Fri 22:00 | runs/agent (mock 0G), scorecards, approvals (mock World), anchor + attest in mock chain | contracts **deployed on Arc testnet**, `deployments/arc.json`, Studio share URL, roles granted, cycle funded; web: claim sign UI, cosign page, approval page | **flip A to `CHAIN_MODE=live`** and run `pnpm e2e:chain` (anchor + attest + release succeed on testnet) |
| **G3** | Sat 13:00 | revision flow + `applyRevision`; real 0G inference + storage replica (if credits/env work); live World verifier (if confirmed) | scorecard/diff/payout/verify/audit screens; ENS identities; live World client flow (or documented mock) | `pnpm e2e:demo` (A, API-level) green incl. revert path |
| **G4** | Sat 20:00 | **feature freeze.** negative tests n01-n18 pass | all screens complete; demo page `/demo` drives `s1..s4` steps | `pnpm e2e:demo` x3 green; checklist in AGENT_B 8 |
| **G5** | Sun 02:00 | hardening, one-command reset (`pnpm --filter @proofwork/api seed:reset`), run-book | README, architecture diagram, video recorded, Studio URL verified | fresh clone runs from README on a second machine |
| **G6** | Sun 07:30 | tag `submission` | submit on the portal (before 09:00 IST; **re-check the deadline on the event page**) | portal confirmation |

Rule: **never start a gate's dependent work against an unmet gate - use the mock** (Prism for B before G1; `CHAIN_MODE=mock` for A until G2).

---

## 11. Triage - if it breaks, who fixes?

| Symptom | First suspect | Owner |
|---|---|---|
| `spec:check` fails after pull | someone edited a generated file / spec without `spec:build` | the last committer |
| EIP-712 signature rejected | domain `chainId`/`verifyingContract` taken from env instead of `/v1/config/public`; BigInt vs number; address not checksummed | B (client) then A |
| Commitment mismatch in the UI "verify yourself" panel | UI re-implemented hashing instead of using `@proofwork/crypto`, or float/key-order in JSON | B |
| `attestScore` reverts | role not granted; batch/supersede id wrong; ABI drift | B (roles/ABI) then A |
| Payout amount differs from UI | engine vs vault math drift; check `vectors.json` `revision_cases` against the contract tests | B (vault) with A |
| Score differs between runs | non-determinism in the engine (Date.now, float, ordering) | A |
| World approval fails live but passes mock | payload shape / action / signal binding | A (`WorldVerifier`) + B (client) together |
| 0G call fails | wrong environment (testnet vs mainnet) or credits - fall back to `ZEROG_MODE=mock`, keep the demo green | A |

---

## 12. Unknowns register (verified status as of spec time; resolve early, never block on them)

| # | Unknown | Impact | Fallback already designed | Owner | Resolve by |
|---|---|---|---|---|---|
| U1 | Exact World Agent Pass call sequence for server verification | approval/co-sign "live" mode | opaque `world_result` + adapter; `mock` mode | A+B | ask a World mentor Fri AM |
| U2 | 0G credits work on testnet or mainnet (`router-api.0g.ai` is mainnet) | live AI/storage | `ZEROG_MODE=mock`; storage replica to local disk | A | ask 0G mentor Fri AM |
| U3 | 0G prize fit for an enterprise tool (docs aimed at consumer apps) | prize eligibility | daily work-log extraction (whisper + extraction) as the consumer-style hook | A | ask 0G mentor |
| U4 | Arc testnet chainId/RPC/explorer, USDC address and **decimals via ERC-20 interface** | vault math | vault asserts `decimals()==6`; mock USDC deployed on Studio if needed | B | Fri 09:00 in Studio |
| U5 | Arc Studio compiler version / OpenZeppelin import availability | contract code | vendor a minimal AccessControl + SafeERC20; interfaces use `^0.8.0` | B | Fri 09:00 |
| U6 | ENSv2 availability on Sepolia | ENS prize | viem ENS reads on Sepolia/mainnet (v1-compatible) for names + text records | B | Fri PM |
| U7 | Event deadline (assumed Sun 8 Nov 09:00 IST) | everything | submit by 07:30 | both | confirm on event page now |
| U8 | Statistics on slides come from secondary sources | credibility | cite primaries or drop the number | B | before video |
| U9 | Business model numbers are hypotheses | pitch | present as hypotheses | B | pitch writing |
| U10 | Prize rules change on the portal | scope | re-read each sponsor page Sat 12:00 | both | Sat 12:00 |

---

## 13. Submission definition-of-done (per sponsor)

- **Arc/Circle:** contracts authored/deployed through Arc Studio (shareable Studio URL in README), USDC escrow with holdback/dispute/revision, working frontend + backend, architecture diagram, demo video, repo.
- **World:** manager approval requires a World step-up (Agent Pass) validated server-side; denied path demonstrably blocks attestation and payout; co-signer World ID path; mock clearly labelled where used.
- **0G:** AI draft + extraction run on Private Computer with `tee_verified` shown in the UI trace; encrypted replica stored on 0G Storage with root shown in the evidence panel (or mock labelled).
- **ENS:** the evidence agent has an ENS identity (`kra-agent...`) with text records (role, spec version, policy hash) shown on every run; employee handles resolved in payout/verify views.
- **Everything:** the five flows in section 6 run on a fresh clone with `pnpm install && pnpm dev` (mock defaults), and the four adversarial demos pass: P0-vs-20-P3, revert -> revised score + clawback math, history carried to cycle 2, prompt-injection note ignored.
