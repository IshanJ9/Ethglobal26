# Handoff from B to A (Fri 6 Nov 2026, night)

B is out of tokens until the limit resets. This file says exactly what exists, what is live and verified, and what is left. Commit references are on `main`.

## 1. What is built and verified

| Area | State | Where |
|---|---|---|
| **CR-004 clusters** | 5 clusters (department.level), one plan each, 26 people. Board with rank, percentile, z-score, per-KRA spread and board hash. Cross-cluster comparison returns 409 | `apps/api/src/review/clusters.ts`, `/clusters` |
| **Context (layer 2)** | 3 past periods (HRIS `performance_review`) + deadlines (tickets `delivery_timeliness`), loaded as normal evidence by step `s5_cluster_context`. Trend, volatility, rates and rule-based signals | `review/context.ts` |
| **0G reasoning (layer 3)** | Packet built only from vault payloads whose commitments recompute. `0gm-1.0-35b-a3b` (TeeML) writes the review. **Number check** and **wording check**: one retry, then a labelled deterministic fallback | `review/reasoning.ts`, `review/reviews.ts`, `/reviews/[id]` |
| **0G Storage** | **Live.** `ZEROG_STORAGE_*` + `ZEROG_PRIVATE_KEY` (A's 0G wallet `0x7af2…3606`, funded with 0.5 OG; about 0.0012 OG per upload) in B's `apps/api/.env`. New evidence goes to 0G automatically. `scripts/replicate-0g.ts` moves old items (upload, download, byte compare, then switch the pointer) | `replica/replica.ts` (`get()`), `scripts/replicate-0g.ts` |
| **World** | Live: approval, co-sign (both scanned with a real World App on 6 Nov). **New (CR-005):** `pw-anchor-review` (HR step-up before anchoring) and `pw-ack-review` (employee acknowledges the review). Both are bound to the review hash and the nullifier is consumed. Both actions exist in the portal. The RP request is signed on the web server (`apps/web/src/app/api/world/rp-context/route.ts`) | `review/reviews.ts` (`worldCheck`, `anchor`, `acknowledge`) |
| **ENS** | `proofwork-demo.eth` (ENSv2, own subregistry + PermissionedResolver). **48 names, 266 values verified on chain** (`node contracts/scripts/ens-verify-org.mjs`): org root, 5 departments, 5 clusters (`policy` = plan formula hash), `kra-agent`, `review-agent` (`prompt` = keccak of the 0G system prompt, `model`, `rules`), signers `anchor`/`payout`, contracts `registry`/`vault` (ENSIP-11 Arc coin type `0x80000000\|5042002`), 30 people + `acme-cfo`. Manifest: `deployments/ens.json` | `contracts/scripts/ens-org.mjs`, `/org/directory` (48/48 ✓ live), cluster board policy ✓, review page prompt ✓ |
| **Arc** | Live with A's role keys: attest, register, release (Ben: 0.35708 USDC on chain), review anchors (batch ids ≥ 1e9, e.g. 1000000001/2). A's chain lock (9dbe3be) is kept and now also carries the World check | `chain/*`, `review/reviews.ts` |
| **Tests** | 124 API tests green, `spec:check` green (spec **1.4.0**), web lint and types green | |

## 2. Live environment (B's machine)

- API `:8787` with `CHAIN_MODE=live`, `WORLD_MODE=live`, `ZEROG_MODE=live`, `ENS_NETWORK=sepolia`, `CHAIN_AMOUNT_DIVISOR=10000`, `SPEC_VERSION=1.4.0`.
- Web `:3000` (`apps/web/.env.local` holds `WORLD_RP_ID` and `WORLD_RP_SIGNING_KEY`).
- **Only one live API at a time:** A's role keys are in B's `.env`. A, keep your local API on `CHAIN_MODE=mock` while B's is live, or agree who runs it.
- DB: `apps/api/data/proofwork.db`. s1 and s5 are loaded. The local DB has Ben's attested and paid scorecard and several reviews.
- A local `.env` needs `SPEC_VERSION=1.4.0` (the build overrides it anyway and logs it).

## 3. In flight when B stopped

1. **Live World test of the new actions:** review `rev_eef4beca1646af858205` (Ben vs Dev Patel, written by 0G live) was waiting for the HR anchor scan. Next:
   - The user scans → check the anchor tx on explorer.testnet.arc.io and `batchRoot(id)` = `hashes.review_hash`.
   - Switch persona to Ben (`/demo` → Ben Carter) → open `/reviews/rev_eef4…` → "I received this review (World ID)" → the user scans → `acknowledgement` is set.
2. **0G replication of Software IC:** the background job was moving 65 items (15 done). Re-run `pnpm --filter @proofwork/api exec tsx scripts/replicate-0g.ts --cluster software.ic`; it skips items already on 0G. Then use `--all` for the rest (about 250 items, about 0.3 OG).

## 4. What is left (priority order)

1. **Review latency (118 s on the last live run).** Likely: the TeeML model reasons for a long time, and the vault downloads 0G items before calling it. Options:
   - (a) Cap `max_tokens` lower and ask for fewer talking points and citations.
   - (b) Run the vault reads with higher concurrency (`VaultReader` concurrency 4 → 8).
   - (c) Show progress in the UI.

   A booth demo wants under 45 s.
2. **Ack CR-005** (spec 1.4.0 World step-ups + reasoning-agent identity), or object.
3. **TEE verdict:** 0G's router returns no `tee_verified`. If 0G can tell us how to verify a `ZG-Res-Key` (broker `processResponse`?), add it to `ZeroGReasoner` and to the claim drafter. Until then the UI honestly says "not reported".
4. **Production build:** `pnpm --filter @proofwork/web build` (stop the dev server first; they share `.next`).
5. **Move the `submission` tag** to the final commit (currently on `f3d309d`).
6. **Frontend doc** (`docs/frontend-requirements.md`): add `/clusters`, `/reviews`, `/reviews/[id]`, `/org/directory`.
7. Polish (Apple style), three full click-throughs on live services, the video, and the submission text (README already has a section per sponsor). B will pick these up after the reset.

## 5. Useful commands

```bash
pnpm spec:check
pnpm --filter @proofwork/api test
pnpm --filter @proofwork/api zerog:probe
pnpm --filter @proofwork/api chain:probe
node contracts/scripts/ens-verify-org.mjs                    # every ENS name/record in deployments/ens.json
cd apps/api && npx tsx ../../contracts/scripts/ens-org.mjs --parent proofwork-demo.eth --records-only   # re-sync ENS records (e.g. after changing SYSTEM_PROMPT)
pnpm --filter @proofwork/api exec tsx scripts/replicate-0g.ts --cluster software.ic
```

**If you change `SYSTEM_PROMPT` in `review/reasoning.ts`, re-run the `ens-org --records-only` line,** or the review page will show "✗ differs from the ENS prompt record". That check is deliberate.
