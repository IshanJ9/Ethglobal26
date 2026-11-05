# Proofwork - verified KRA and bonus engine

> **Agents collect. Code computes. Humans decide. Chain proves.**

Proofwork is a plug-in layer for the HRMS/CRM stack (Zoho, SAP, ...) that removes the year-end appraisal scramble: an AI agent gathers evidence from the systems of record, a **deterministic engine** (no LLM) turns it into KRA scores, a **human approves with a World step-up**, and only salted commitments and Merkle roots are anchored on an **Arc** testnet. Bonuses sit in a USDC vault with holdback, dispute and **revision/clawback** logic, so a reverted PR changes the payout, not just a spreadsheet.

Scope for this hackathon build: **Software, Marketing and Sales** departments, to show the full product lifecycle. ZK selective-disclosure is on the roadmap, not in the build.

## Status of this scaffold
This repository currently contains the **frozen shared spec and the two build plans**. The apps are built by two coding agents working in parallel:

| File | For |
|---|---|
| `INTEGRATION.md` | both - the compatibility contract, flows, gates, unknowns |
| `AGENT_A.md` | backend + AI + data (`apps/api`) |
| `AGENT_B.md` | contracts + frontend + identity (`contracts/`, `apps/web`) |
| `CHANGE_REQUESTS.md` | the only way to change a frozen interface |
| `spec/` | OpenAPI 3.1, Solidity interfaces + ABIs, EIP-712, hashing and scoring rules, golden vectors, fixtures, reference engine |

## What keeps the two sides compatible
- One OpenAPI file; TypeScript types are **generated** from it (`packages/shared`).
- One crypto package (`packages/crypto`) used by both apps, proven equal to an **independent Python implementation** on shared golden vectors (canonical JSON, commitments, Merkle proofs, EIP-712 digest + signatures).
- A **JS reference engine** proven equal to the same Python vectors, plus a demo scenario whose expected scores are computed from it.
- Solidity **interfaces compiled to ABIs**; `pnpm check:abi` fails if the Arc Studio contracts are not an ABI superset.
- Everything external (chain, World, 0G, ENS) sits behind an adapter that defaults to **mock**, so the demo always runs and every mock is labelled in the UI.
- `pnpm spec:check` is the single pre-push gate.

## Commands
```
pnpm install
pnpm spec:check        # run before every push (openapi, fixtures, vectors in 2 languages, ABIs, generated types)
pnpm spec:build        # regenerate ABIs, vectors, fixtures, types (only when spec changes via a CR)
pnpm test:crypto       # TS crypto package vs Python vectors
pnpm check:abi         # Agent B: Studio ABI export vs frozen interfaces
pnpm mock:api          # Prism mock of the full API on :8787 (shape only)
pnpm dev               # api + web (once apps exist)
```
Requires Node 22, pnpm 10, Python 3 with `pyyaml`, `openapi-spec-validator`, `eth-account` (only for `spec:build` / the optional OpenAPI validator step).

## Demo story (all numbers computed by the engine)
1. Asha (senior dev) logs a client call -> AI draft (0G, TEE trace) -> she verifies the commitments locally and signs (EIP-712) -> the client CFO co-signs by magic link/wallet or World ID -> **access closes**.
2. Scorecards: one P0 fix (40,000 milli) beats twenty P3 fixes (capped at 10,000); a self-introduced bug earns 0.
3. Manager approves with a World step-up -> evidence root anchored, score attested on Arc -> 80% of the bonus paid, 20% held back.
4. PR #101 is reverted -> scorecard v2 (score 9071 -> 8621 bps, multiplier 100% -> 90.52%) -> v1 attestation revoked -> vault forfeits 474 USDC of the held amount.
5. Next cycle blends her history; a prompt-injection note in a work log changes nothing; HR shreds a record and verification shows the proof stays valid while the data is gone.

## Honest limits
- No ZK proofs in this build (roadmap). Hashes prove *what was signed*; if raw data is lost they cannot recreate it - hence the org-DB primary plus encrypted 0G replica.
- "Designed for erasure via crypto-shredding" - not a claim of GDPR/DPDP compliance.
- DORA metrics are team-level context and are weighted accordingly; they are not individual performance measures.
- Business-model figures and market statistics are hypotheses until backed by primary sources.
