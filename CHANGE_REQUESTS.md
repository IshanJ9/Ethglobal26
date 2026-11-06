# CHANGE_REQUESTS.md

The only way to change anything under `spec/`, `INTEGRATION.md`, `packages/crypto`, or an interface the other agent consumes.
Process: INTEGRATION.md section 2.1. Keep entries short. Newest at the bottom. Status: `proposed` -> `acked` | `objected` -> `merged` | `withdrawn`.

## Template (copy)
```
### CR-NNN  <title>
- Proposer: A | B        Date/time (IST):
- Kind: additive | breaking
- Problem: (what failed or is missing, with evidence)
- Proposal: (exact change: file, field, enum value, signature)
- Impact on the other agent: (what they must change, if anything)
- Workaround until merged:
- Status: proposed
- Other agent reply: ack | object (why)
- Merged in: commit hash, spec VERSION
```

## Pre-registered likely CRs (do not file until the trigger happens)
| Trigger | Likely CR |
|---|---|
| U1 resolves: Agent Pass needs extra fields from the server (e.g. an `rp_context` or signed request) | add optional fields to `Approval` and `CosignView` (additive) |
| U4: Arc USDC interface is not 6 decimals or has no ERC-20 `decimals()` | vault asset decimals rule + `Amount` documentation (breaking only if base-unit meaning changes) |
| U5: Studio compiler older than the interface pragma | pragma already `^0.8.0`; only needed if a feature of the interface requires newer |
| Contract implementation needs an extra argument in `registerPlan` (e.g. token override) | additive overload, never a signature change |

## Log

(empty - first entry is CR-001)

### CR-001  Optional `ai_flags` on CosignView
- Proposer: A        Date/time (IST): Fri 6 Nov 2026
- Kind: additive
- Problem: AGENT_A 3.9 / INTEGRATION F1.8 say the co-signer sees the claim's AI flags (e.g. `prompt_injection_suspected`, demo c2), but `CosignView` is `additionalProperties: false` without an `ai_flags` field, so the API cannot return them to the co-signer.
- Proposal: `spec/openapi.yaml` `CosignView.properties.ai_flags`: same schema as `Claim.ai_flags` (array of enum `prompt_injection_suspected | low_confidence | fields_inferred`), optional.
- Impact on the other agent: none required; B may render the flags on `/cosign` once merged.
- Workaround until merged: flags are on `Claim` (visible to the employee and their manager); the co-signer page cannot show them yet.
- Status: merged
- Other agent reply: none within 30 min of working time -> ack by timeout (INTEGRATION 2.1)
- Merged in: commit "spec 1.1.0: merge CR-001", spec VERSION 1.1.0 (minor: additive). B: pull, nothing required; `CosignView.ai_flags` is now available to render on /cosign.

### CR-002  Optional World RP context on Approval and CosignView (U1 trigger)
- Proposer: A        Date/time (IST): Fri 6 Nov 2026
- Kind: additive
- Problem: World ID 4.0 (docs.world.org, Nov 2026) verifies proofs at `POST https://developer.world.org/api/v4/verify/{rp_id}` and requires the IDKit request to carry an RP-signed context (`rp_context`: `rp_id`, `nonce`, `created_at`, `expires_at`, `signature`) produced server-side with the signing key ("Never generate RP signatures on the client"). `Approval` and `CosignView` only expose `world_action` + `challenge`/digest, so the web client has no server-signed context to pass to IDKit in `WORLD_MODE=live`. This is the pre-registered U1 CR.
- Proposal: `spec/openapi.yaml`: add optional `world_rp_context: { type: object, additionalProperties: true, description: "Opaque RP context for IDKit (WORLD_MODE=live only); pass through unchanged." }` to `Approval` and `CosignView`. Populated by A when `WORLD_MODE=live`; absent in mock.
- Impact on the other agent: B passes `world_rp_context` to IDKit unchanged when present; nothing changes in mock mode.
- Workaround until merged: `WORLD_MODE=mock` (labelled MOCK in the UI). A's live verifier already validates v4 proofs server-side (action + signal binding, nullifier replay) and fails closed for `agent_pass` until U1 is confirmed with a World mentor.
- Status: proposed
- Other agent reply: ack (B, Fri 6 Nov 2026). The web client will pass `world_rp_context` to IDKit unchanged when present and ignore it when absent; mock mode unchanged.
- Merged in:

### CR-003  Optional on-chain amount divisor in PublicConfig (testnet funding)
- Proposer: A        Date/time (IST): Fri 6 Nov 2026
- Kind: additive
- Problem: the fixture targets are 5,000 USDC, but the Arc testnet vault holds 5 USDC per cycle (20 USDC grant), so a real release reverts with "insufficient cycle balance". B suggested scaling inside A's chain adapter (no fixture change). A now runs the vault at 1/`CHAIN_AMOUNT_DIVISOR` of the real amounts: the target is divided going out, and payout amounts are multiplied back, so every API amount stays at full scale (exact for all seed fixtures; non-divisible targets are refused, never rounded). Live `.env` uses 10000 (Asha's 5,000 USDC entitlement reserves 0.5 USDC on chain). The UI must say so, and needs the number from the API instead of hardcoding it.
- Proposal: `spec/openapi.yaml`: in `PublicConfig.chain` add optional `amount_divisor: { type: integer, minimum: 1, description: "On-chain amounts are the API amounts divided by this (testnet funding). 1 or absent = unscaled." }`. A serves it when `CHAIN_AMOUNT_DIVISOR > 1`.
- Impact on the other agent: B shows "on-chain amounts scaled 1:N" next to payouts and explorer links when `amount_divisor > 1`; anything compared against the explorer (vault balances, Transfer amounts) must be divided by N.
- Workaround until merged: B hardcodes the label to 1:10000 when `chain_mode == "live"`.
- Status: merged
- Other agent reply: ack (B, Fri 6 Nov 2026). Web reads `chain.amount_divisor` when present and shows "On-chain amounts scaled 1:N" (ChainScaleNote) in live mode; until merged it falls back to 1:10000 when chain_mode is live. Mock mode shows nothing.
- Merged in: spec 1.2.0 (Fri 6 Nov 2026); A serves `chain.amount_divisor` when `CHAIN_AMOUNT_DIVISOR > 1`

### CR-004  Peer clusters, context layer and 0G-backed review reasoning (mentor feedback)
- Proposer: B        Date/time (IST): Fri 6 Nov 2026
- Kind: additive (new endpoints, new fixtures, enum widening) + fixture change (Ben/Chen move to the IC plan)
- Problem: mentor review. KRAs must differ per department AND per level, and people may only be compared inside their own cluster (e.g. Software IC vs Software IC, never vs Senior). A score alone does not survive a bonus review: HR needs (1) the KRA score, (2) context - how the person did before, deadlines hit or missed, targets over/under - and (3) a written reasoning HR can hand the employee that is provably built only from the committed, encrypted evidence (0G Storage) and produced inside 0G Private Computer, so an employee cannot say "you did not validate this".
- Proposal:
  - **Clusters** = `department.level` (`spec/fixtures/clusters.json`), each with its own plan. New plans `pln_eng_ic_v1` (Software IC) and `pln_product_v1` (Product); `pln_eng_v1` becomes the Software Senior IC plan. Ben and Chen move to `pln_eng_ic_v1`. `department` enum gains `product`. Each cluster gets peers (seed-org) so statistics are meaningful.
  - **History + deadlines** enter as ordinary evidence through the ledger (so they are committed, hash-chained, envelope-encrypted and replicated to 0G): `hris/performance_review` (one per past period) and `tickets/delivery_timeliness` (current cycle). Metric keys are not KRA keys, so scores are unchanged. Dev step `s5_cluster_context` in `spec/fixtures/seed-clusters.json` loads them.
  - **Endpoints:** `GET /v1/clusters`, `GET /v1/clusters/{cluster_id}/board` (layer 1 within the cluster: rank, percentile, z-score, per-KRA distribution), `GET /v1/employees/{employee_id}/context` (layer 2), `POST /v1/reviews` + `GET /v1/reviews` + `GET /v1/reviews/{review_id}` (layer 3), `POST /v1/reviews/{review_id}/anchor` (review hash anchored on Arc via `anchorBatch`, batch ids >= 1e9). Cross-cluster comparison -> 409 `cluster_mismatch`. `Employee.cluster_id` added (optional).
  - **Reasoning rules:** the packet is assembled from vault payloads (0G replica -> decrypt -> recompute commitment == ledger commitment); every number in the model's text must exist in the packet or the output is rejected (one retry, then a labelled deterministic fallback). Review hash = keccak(canonicalJson({packet_hash, context_hash, inputs_hash, output_hash})).
- Impact on the other agent: A's existing endpoints and numbers are unchanged except Ben/Chen scorecards now use the IC plan targets. B builds the endpoints (agreed with the user, 6 Nov) plus the web screens.
- Workaround until merged: none needed; additive.
- Status: proposed
- Other agent reply: ack (A, Fri 6 Nov 2026). Reviewed B's edits to A's files: test changes are the Ben/Chen IC-plan values and new counts, and the new Ben/Chen expectations match both A's engine port and the JS reference engine (engine.seed test). Gates green (spec:check, API tests, e2e:demo). One fix by A: review anchoring now runs under ChainService's chain-write lock (`exclusive`), so concurrent anchors cannot double-send or race batch ids/nonces (test added).
- Merged in: spec 1.3.0 (b6b42c0, B); lock fix by A
