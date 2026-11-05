# AGENT_B.md - Contracts + Frontend + identity

You are **Agent B**. You build `contracts/` (Arc Studio), `apps/web`, the ENS and World client integrations, the demo page, the diagrams, the README and the submission package. A teammate's agent (**Agent A**) builds `apps/api` - the REST API, evidence ledger, scoring engine, AI/agent layer and **every chain transaction**. You never edit their directory and they never edit yours.

**Read first, in order:** `INTEGRATION.md` -> `spec/openapi.yaml` -> `spec/solidity/*.sol` -> `spec/ENGINE.md` (sections 2 and `revision`) -> `spec/HASHING.md` -> `spec/eip712.json` -> `spec/fixtures/seed-*.json`. Then `pnpm install && pnpm spec:check` must be green **before writing code**.

Product rule you make visible: **agents collect, code computes, humans decide, chain proves.** The UI must always make clear which step is AI, which is code, which is a human, and which is on-chain - and whether it is **MOCK** or **LIVE**.

---

## 0. Hard rules (compatibility)

1. **Contracts must be an ABI superset of `spec/abi/*.json`.** Export from Studio to `contracts/abi/AttestationRegistry.json` and `contracts/abi/BonusVault.json`; `pnpm check:abi` must pass. You may add functions/events; you may not change or remove interface ones.
2. **Never re-implement hashing/EIP-712.** Import `@proofwork/crypto` (`commit`, `claimDigest`, `claimTypedData`, `toClaimMessage`, `recoverClaimSigner`, `buildMerkle`, `verifyMerkleProof`...). Same viem version as the API (2.21.x).
3. **Types come from `@proofwork/shared`** (generated). No hand-written DTOs. All HTTP goes through one typed client (`openapi-fetch`) in `apps/web/src/lib/api.ts`.
4. **Chain id, contract addresses and the EIP-712 domain come only from `GET /v1/config/public`.** Never from the web env, never hard-coded.
5. **The browser never sends a chain transaction.** It signs EIP-712 messages and calls the API. (Your `contracts/scripts/*` may send transactions for deploy/fund/role setup - those are operator scripts, not app code.)
6. **Money:** decimal strings + `BigInt` only; format USDC for display from base units (6 decimals) in one helper. **Scores:** integers; display `bps/100`.
7. **World results are opaque:** pass exactly what the SDK returned in `world_result`; never reshape or inspect it.
8. **Honest UI:** show a `MOCK` badge for any adapter whose mode is `mock` (config tells you). Never label a mock proof "verified by World/0G/Arc".
9. **Handle the spec handshake:** read `X-Spec-Version` / `/healthz`; if its major differs from `SPEC_MAJOR` (compiled constant `1`), show a blocking banner.
10. Anything missing or wrong in the spec -> **CR** (CHANGE_REQUESTS.md); mock around it meanwhile.

---

## 1. Stack (pinned)

Contracts: Solidity (Arc Studio compiler; interfaces are `^0.8.0`), OpenZeppelin `AccessControl`/`SafeERC20`/`ReentrancyGuard` **if Studio supports imports - otherwise vendor minimal versions** (U5). Tests: Foundry if installed (`forge test`), else a viem-based harness against a local node; either must encode the vector cases below.
Web: **Next.js 15 (App Router), React 19, TypeScript 5.6, Tailwind 3.4**, `openapi-fetch`, `@tanstack/react-query`, viem 2.21 (wallet signing, ENS), zod for form validation, `@worldcoin/idkit` for the World client flows (exact packages per U1). Package name **`@proofwork/web`**, scripts: `dev` (port 3000), `build`, `lint`. Mermaid for diagrams.

```
contracts/
  src/ AttestationRegistry.sol  BonusVault.sol  MockUSDC.sol (only if the Arc USDC interface is unusable)
  test/                         registry + vault tests (vector-driven)
  scripts/                      deploy.ts  grant-roles.ts  fund.ts  ens-setup.ts
  abi/                          exported ABIs (checked by pnpm check:abi)
deployments/arc.json            written by deploy.ts (schema: INTEGRATION 7)
apps/web/src/
  app/                          routes (section 4)
  lib/ api.ts config.ts signing.ts wallets.ts world.ts ens.ts format.ts errors.ts
  components/                   see section 4
docs/diagrams/                  mermaid sources + exported PNG/SVG
```

---

## 2. Contracts

### 2.1 AttestationRegistry (implements `IAttestationRegistry`)
- `AccessControl`; deployer = `DEFAULT_ADMIN_ROLE`. `ANCHOR_ROLE = keccak256("ANCHOR_ROLE")`, `ATTESTER_ROLE = keccak256("ATTESTER_ROLE")`. Expose both getters (interface requires them).
- `anchorBatch(root, batchId, count)`: ANCHOR_ROLE; `root != 0`, `count > 0`, `batchRoot[batchId] == 0` else revert; emit `BatchAnchored(batchId, root, count, block.timestamp)`.
- `attestScore(...)`: ATTESTER_ROLE; ids start at **1**; require `subjectId != 0`, `version >= 1`, `multiplierBps <= 30000`.
  - If `supersedes != 0`: old must exist, not revoked, same `subjectId` and `cycleId`, `version > old.version`; set `old.revoked = true`, emit `AttestationRevoked(old, keccak256("superseded"))`.
  - If `supersedes == 0` and a non-revoked latest exists for `(subjectId, cycleId)` -> revert (`"must supersede"`).
  - Store; set `latest[subjectId][cycleId] = id`; emit `ScoreAttested`.
- `revoke(id, reasonHash)`: ATTESTER_ROLE; if it is the latest, clear `latest`.
- `getAttestation`, `batchRoot`, `latestAttestation` (0 if none/revoked), `hasRole`.
- **Never store names, scores in clear, or raw claims.** Only commitments, roots, pseudonymous ids, bps.

### 2.2 BonusVault (implements `IBonusVault`)
- Constructor `(asset, registry)`; `require(IERC20Metadata(asset).decimals() == 6)` (U4 - if Arc's USDC interface differs, deploy `MockUSDC` with 6 decimals and note it in the README).
- Roles: `PLANNER_ROLE`, `PAYOUT_ROLE`, `DISPUTER_ROLE`, `RESOLVER_ROLE` (keccak of the names). `ReentrancyGuard` + `SafeERC20`.
- State per `(subjectId, cycleId)` = `PayoutState` (see interface) + `maturitySeconds`; `cycleBalance[cycleId]` = unreserved funds.
- `fundCycle`: `transferFrom(msg.sender)`, `cycleBalance += amount`.
- `registerPlan`: PLANNER; status `None` -> `Registered`; `payee != 0`, `holdbackBps <= 10000`.
- `release(attId)`: PAYOUT; `a = registry.getAttestation(attId)`; require `!a.revoked`, plan `Registered`. `ent = target*mult/10000`; `immediate = ent*(10000-holdback)/10000`; `held = ent - immediate`; `require(cycleBalance >= ent)`; `cycleBalance -= ent`; pay `immediate`; set `attestationId`, `entitlement`, `paid`, `held`, `maturityAt = now + maturitySeconds`; status `Active` (or `Closed` if `ent == 0`). Emit `Released`.
- `releaseHoldback(attId)`: PAYOUT; `attId == payout.attestationId`, not revoked, status `Active` (not `Disputed`), `now >= maturityAt`; pay `held`, `paid += held`, `held = 0`, status `Closed`.
- `dispute` (DISPUTER, `Active` -> `Disputed`), `resolveDispute(attId, releaseFunds)` (RESOLVER): release -> pay `held`, else forfeit `held` back to `cycleBalance`; both -> `Closed`.
- `applyRevision(oldId, newId)`: PAYOUT; `payout.attestationId == oldId`; new attestation same subject+cycle, not revoked, `new.supersedes == oldId`. Compute **exactly** (ENGINE.md `revision`):
  ```
  newEnt = target*newMult/10000
  heldRemaining = max0(newEnt - paid)
  overpaid  = max0(paid - newEnt)           // recorded, offset against future cycles; never clawed back by force
  forfeited = max0(held - heldRemaining)    // returned to cycleBalance
  extraOwed = max0(heldRemaining - held)    // taken from cycleBalance (require enough funds) and added to held
  ```
  Then `held = heldRemaining`, `entitlement = newEnt`, `attestationId = newId`, `forfeited += forfeited`, `overpaid = overpaid`; reopen to `Active` if it was `Closed` and `held > 0`. Emit `RevisionApplied`.
- Every external state change emits the interface event; no function may pay a revoked or non-matching attestation.

### 2.3 Contract tests (you own; mirror these ids in test names)
| id | test |
|---|---|
| c01 | registry: only ANCHOR can anchor; duplicate batchId reverts; zero root reverts |
| c02 | registry: attest v1 then v2 with `supersedes` revokes v1 and `latestAttestation` returns v2 |
| c03 | registry: attest without superseding an existing latest reverts |
| c04 | registry: supersede with wrong subject/cycle or lower version reverts |
| c05 | vault: `payout_split` case from `vectors.json` (`target 5e9, mult 10000, holdback 2000` -> immediate 4e9, held 1e9) |
| c06 | vault: `revision_cases` x3 from `vectors.json` match exactly (mult 7500 / 9500 / 12000) |
| c07 | vault: revision to the demo v2 (`seed-scenario` s3 multiplier for emp_dev_a) gives forfeited 474000000, held 526000000 |
| c08 | vault: release reverts for a revoked attestation |
| c09 | vault: holdback before maturity reverts; after maturity pays; double release reverts |
| c10 | vault: dispute freezes holdback; resolve(true) pays, resolve(false) forfeits |
| c11 | vault: role checks on every restricted function |
| c12 | vault: constructor rejects a non-6-decimals asset |
| c13 | invariant: `balance(vault) >= sum(cycleBalance) + sum(held)` after any sequence |
| c14 | vault: upward revision pays `extraOwed` only if funds exist, else reverts |

### 2.4 Arc Studio procedure (hackathon requirement - the prize needs the work to **start in Arc Studio**)
1. Fri 09:00: create the project in Arc Studio **first**, paste the contracts there, compile. Record the Studio share URL in the README.
2. Confirm chainId, RPC, explorer, faucet and the USDC address/decimals on the Arc docs/Studio (U4, U5). Write findings to `docs/arc-notes.md`.
3. Deploy via Studio to Arc testnet; export both ABIs to `contracts/abi/`; run `pnpm check:abi` (must pass) - **if it fails, fix the contract, not the ABI**.
4. `contracts/scripts/grant-roles.ts` grants ANCHOR+ATTESTER to Agent A's anchor address, PLANNER+PAYOUT+DISPUTER+RESOLVER to the payout address (addresses from Agent A at G0).
5. `contracts/scripts/fund.ts` approves USDC and calls `fundCycle(1, X)` and `fundCycle(2, X)` (enough for all demo employees at target).
6. Write `deployments/arc.json` (schema INTEGRATION 7). Tell Agent A to flip to live.

---

## 3. Identity: World and ENS

### 3.1 World (client side)
- `lib/world.ts` exposes `requestWorldProof({ action, signal }): Promise<WorldResult>`:
  - `world_mode=mock` -> returns `{adapter:"mock", payload:{action, signal, nullifier:"0x"+64 random hex}}` (button text "Mock World verification" + MOCK badge).
  - `world_mode=live` -> the real flow. **Priority 1: Agent Pass step-up for the manager approval** (World Agent Pass prize is open); **priority 2: IDKit proof-of-human for the co-signer** (`auth_method=world_id`). The exact Agent Pass call sequence is unconfirmed (U1): ask a World mentor on Friday morning, implement behind this one function, and send the answer to Agent A the same minute.
- Bind every proof to the `action` and `signal` the server gave you (`Approval.world_action` + `Approval.challenge`; `CosignView.world_action` + claim digest). Never invent your own.
- Roles are not World's job: it proves a human. The server decides authority.

### 3.2 ENS
- Goal: make identity real, not decorative. Register a Sepolia parent name (or use what the hackathon provides - U6), then subnames: `kra-agent.<parent>.eth` (the evidence agent), plus employee handles (`asha.<parent>.eth` ...) and the demo client. Set text records on the agent name: `role=evidence-agent`, `spec=1.0.0`, `policy=<formula_hash of the active plan>`, `url=<repo/studio>`.
- `lib/ens.ts` (viem): `resolveName`, `getText`, reverse lookup with graceful failure. Components: `<AgentBadge>` (every run trace), `<PersonName>` (shows ENS handle when present, else display name), payout view shows the payee as ENS + address.
- If ENSv2 tooling is unstable, ENS v1-compatible reads via viem on Sepolia are acceptable; document what you used. `ENS_NETWORK=none` falls back to seed display names with a visible "ENS not resolved" note.

---

## 4. Web app

### 4.1 Routes (each lists the endpoints it uses)
| Route | Who | Purpose | Endpoints |
|---|---|---|---|
| `/login` | all | persona picker (dev), SSO placeholder | `dev/login`, `me` |
| `/` | employee | my cycle: scorecard status, claims, evidence summary | `cycles`, `claims`, `evidence`, `scorecards` |
| `/claims/new` | employee | free text -> AI draft | `claims` (POST), `org/plans/{id}` for KRA choice |
| `/claims/[id]` | employee | draft review, **signing panel**, grant modal, status timeline | `claims/{id}`, `draft`, `signing-package`, `submit`, `cosign-grants` |
| `/cosign` | external | co-signer view + sign/decline (token from URL fragment) | `cosign/view`, `cosign/sign`, `cosign/decline` |
| `/team` | manager/hr | reports, scorecard list, "needs revision" flags | `org/employees`, `scorecards` |
| `/scorecards/[id]` | manager/hr/self | KRA lines, evidence list with proofs, gate status, carry-forward, **diff vs previous version**, approval + attest + payout actions | `scorecards/*`, `evidence`, `approvals`, `chain/*`, `payouts/*` |
| `/approvals/[id]` | manager | review + **World step-up** + approve/deny | `approvals/*` |
| `/payouts/[scorecard]` | all | holdback/forfeit/overpaid timeline, explorer links, release actions | `payouts/*` |
| `/verify` | public | paste claim/evidence JSON + salt -> run `/v1/verify`; also recompute locally | `verify` |
| `/audit` | hr | hash-chained audit log | `audit` |
| `/privacy` | all | "who can see what" matrix, live example per role | static + `me` |
| `/org/plans` | manager/hr | plan/KRA definitions with `basis` sources and weights | `org/plans` |
| `/demo` | presenter | persona switcher, step buttons (`dev/inject` s1..s4), scripted claims c1-c3, negative-test checklist with pass/fail | `dev/*`, others |

### 4.2 Key components
- `SigningPanel`: **before signing**, recompute `claimCommitment` and `evidenceCommitment` from `claim_value`/`evidence_value` + salts using `@proofwork/crypto`, rebuild the typed data from the values, compare to `signing-package.typed_data` and `digest`, and compare the domain to `/v1/config/public`. On any mismatch: red banner "Server data does not match what you are signing", signing disabled. This is the anti-blind-signing guarantee and a demo highlight. Then `signTypedData` -> `submit`.
- `WalletSwitcher`: (a) **demo wallets** - viem `privateKeyToAccount(keccak256("proofwork-demo-persona:"+persona_id))`, shown only when `auth_mode=dev`, clearly labelled DEMO KEYS; (b) injected wallet (MetaMask) for real signing. Co-signer page supports both.
- `InferenceTrace`: shows provider, model, request id, `tee_verified` (green/grey/MOCK), prompt/output hashes, and AI flags (`prompt_injection_suspected` is amber and explained).
- `EvidenceTable`: status chips (unverified/verified/provisional/vested/reverted...), source icons, commitment (short), batch id + Merkle proof expander, replica root, "Verify" link.
- `ScoreBreakdown`: per KRA: actual, target, attainment, cap, weight, contribution; gate banner; carry-forward banner; bug-credit panel (tier table showing why 1xP0 beats 20xP3).
- `RevisionDiff`: two-column diff of lines + evidence added/removed + bonus delta, then the payout consequence (forfeited / overpaid / extra owed) in USDC.
- `PayoutTimeline`: Registered -> Released -> Holdback -> Closed/Disputed, with revision events.
- `ChainBadge`: tx hash + explorer link (from `explorer_url`), MOCK badge when `chain_mode=mock`.
- `ErrorBoundary`/toast mapping from `error.code`:

| code | message to show |
|---|---|
| `unauthorized` | Session expired - sign in again |
| `forbidden` | You do not have permission for this action |
| `not_found` | Not found (or not visible to you) |
| `invalid_state` | That item changed - refresh |
| `approval_required` / `approval_denied` | Manager approval is required before this step (denied approvals block attestation and payout) |
| `grant_closed` | This link is no longer active |
| `signature_mismatch` | The signature did not match the expected wallet / chain |
| `world_verification_failed` | World verification failed - try again |
| `gate_failed` | Too little evidence is verified yet to pay a bonus |
| `chain_error` | The chain rejected the transaction (shows `details.revert`) |
| `upstream_unavailable` | A service is temporarily unavailable |
| others | show `message` |

### 4.3 UX rules
- Every screen that shows a score also shows **how it was computed** (ENGINE rule names, inputs) and **who/what produced each input** (system-of-record, co-signed, AI-drafted-unverified).
- The co-signer page shows **only** the claim, excerpt, flags, employee signature and a countdown; after signing it shows "Access closed" (the API returns 410).
- Honest-limits box on `/verify`: "A hash proves what was signed, not what the text said, if the original data is lost. Proofwork keeps an org database copy and an encrypted 0G replica."
- Accessible by default (labels, focus order, contrast); desktop-first, usable on a laptop projector at 1280px.

---

## 5. Work plan (about 35-38 hours; times IST; gates from INTEGRATION 10)

**Block 0 - Fri 01:00-03:00 (2h) - with Agent A**
- [ ] Pull repo, `pnpm install`, `pnpm spec:check` green.
- [ ] Scaffold `apps/web` (`@proofwork/web`), `lib/api.ts` (openapi-fetch + `@proofwork/shared`), config fetch + spec handshake banner.
- [ ] `pnpm mock:api` (Prism on :8787) works; web loads `/login` against it.
- [ ] Receive Agent A's **role key addresses**. Create the Arc Studio project (empty) and record its URL.

**Block 1 - Fri 09:00-14:00 (5h) -> Gate G1**
- [ ] Studio first: write `AttestationRegistry` + `BonusVault` (+ `MockUSDC` if needed), compile in Studio.
- [ ] Tests c01-c14 (Foundry or viem harness) - at least c01-c06 and c08-c09 green by G1.
- [ ] Export ABIs -> `contracts/abi/`; `pnpm check:abi` green; log U4/U5 findings in `docs/arc-notes.md`.
- [ ] Web: layout, persona login/switcher, `MockBadge`, error mapping, employee dashboard, `/claims/new`, `/claims/[id]` draft review with `InferenceTrace`.
- **G1 proof:** `pnpm check:abi`; web logs in as p_dev_a on Agent A's server and creates a claim.

**Block 2 - Fri 15:00-22:00 (7h) -> Gate G2**
- [ ] Deploy to Arc testnet from Studio; `grant-roles`, `fund`, `deployments/arc.json`; tell Agent A. **Do this before UI polish - it unblocks A.**
- [ ] `SigningPanel` with local verification + wallet switcher; submit; grant modal; `/cosign` page (magic-link + wallet, and World ID path with mock); decline.
- [ ] `lib/world.ts` mock mode; `/approvals/[id]`; `/team`; `/scorecards/[id]` (lines, gate, evidence, approve -> attest buttons).
- **G2 proof:** with Agent A on `CHAIN_MODE=live`, full F1 + F2 clickable: claim -> sign -> co-sign -> score -> approve -> attest (tx visible) -> release.

**Block 3 - Sat 06:00-13:00 (7h) -> Gate G3**
- [ ] Contract tests c07, c10-c14; fix any contract bug found by Agent A's `chain.contract.test.ts`.
- [ ] `RevisionDiff`, `PayoutTimeline`, bug-credit panel, carry-forward banner.
- [ ] `/verify` (server + local recompute), `/audit`, `/privacy`, `/org/plans`, HR shred flow.
- [ ] ENS: parent + subnames + text records; `AgentBadge`, `PersonName`.
- [ ] World live flow per U1 (Agent Pass for approvals; IDKit for co-sign) - keep mock selectable.
- **G3 proof:** `pnpm e2e:demo` (Agent A) green; you can click the revert story end to end.

**Block 4 - Sat 14:00-20:00 (6h) -> Gate G4 (feature freeze 20:00)**
- [ ] `/demo` page: persona switcher, steps s1-s4, scripted claims, negative checklist.
- [ ] Empty/loading/error states everywhere; 1280px layout pass; copy pass; remove dead UI.
- [ ] Click-through the whole story 3 times on fresh data; log bugs for Agent A / fix yours.

**Block 5 - Sat 20:00-Sun 02:00 (6h) -> Gate G5**
- [ ] README (section 7), architecture diagram, flow diagrams, data-visibility matrix image.
- [ ] Record the demo video (section 6). Re-record if any step shows an error.
- [ ] Verify the Studio share URL opens for a logged-out browser; verify explorer links.
- [ ] Fresh-clone test on a second machine following only the README.

**Block 6 - Sun 06:00-07:30 -> Gate G6**
- [ ] Re-check the deadline on the event page; submit each sponsor track with links (repo, Studio URL, video, diagram); screenshot the confirmation.

---

## 6. Demo video script (5 min; every number comes from the app, not slides)
1. **0:00-0:40 Problem.** Annual KRA/bonus cycles are slow, subjective and unverifiable across teams and clients. Use **primary-source** statistics only (U8) or none.
2. **0:40-1:30 Claim.** p_dev_a types a work note -> AI draft with TEE trace (0G) -> "verify it yourself" panel recomputes commitments -> signs.
3. **1:30-2:15 Co-sign.** Client CFO opens the magic link (and the World ID variant) -> signs -> **access closes** (show the 410 state).
4. **2:15-3:00 Score.** Collect -> deterministic scorecard. Show P0 fixer vs 20xP3 fixer. Manager **World step-up** approves -> anchor -> attest (Arc explorer) -> release 80%.
5. **3:00-3:45 Revert.** PR #101 reverted -> v2 diff -> multiplier drops -> vault forfeits held amount (show USDC numbers) -> attestation v1 revoked, v2 live.
6. **3:45-4:15 Memory + proof.** Cycle 2 carries history; `/verify` with salt; HR shred -> verify shows merkle still valid, data gone. Mention prompt-injection note ignored.
7. **4:15-5:00 Architecture + business.** Diagram, sponsor map, plugin model (Zoho/SAP connectors), business-model **hypotheses**, roadmap (ZK selective disclosure, private-chain mode).

---

## 7. README + submission package (you own)
README sections: problem; one-paragraph solution; architecture diagram; **sponsor integration table** (what is real vs mock, with file links); quickstart (`pnpm install`, `cp .env.example`, `pnpm --filter @proofwork/api seed:reset`, `pnpm dev`); demo walkthrough; honest limits (mock adapters used in the video, ZK not built, "designed for erasure via crypto-shredding" not "GDPR compliant"); roadmap; business-model hypotheses; team.
Per sponsor, a 5-line submission text: what we built, where in the repo, how to run, live vs mock, link to the proof (explorer tx / trace screenshot).

---

## 8. Things you must NOT do
- Edit `apps/api/`, `spec/` (except through a CR), `packages/crypto` (read-only).
- Hard-code addresses/chain ids; re-implement hashing; hand-write API types.
- Show a mock result as verified; claim ZK, GDPR compliance, or fabricated statistics.
- Send chain transactions from the browser; store private keys anywhere but demo-derived ones in dev mode.
- Start UI polish before the contracts are deployed (Block 2 order matters).

## 9. Definition of done
Contracts deployed through Arc Studio with ABI conformance green; the web app runs the five flows in INTEGRATION 6 against a fresh seeded API; `/demo` shows all four adversarial cases passing; README + diagram + video + Studio URL submitted; every MOCK badge in the video is explained in the README.
