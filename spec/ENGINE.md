# ENGINE.md - frozen deterministic scoring rules (spec v1.0.0)

**Agents collect, code computes.** No LLM is ever called in this file's scope. Same inputs => byte-identical outputs.
Reference implementations: `spec/reference/engine.mjs` (JS/BigInt) and `spec/vectors/generate.py` (Python). Both must agree on `spec/vectors/vectors.json`; the aggregation rules in section 3 are authoritative in the JS reference and checked by `spec/fixtures/seed-scenario.json`. Agent A may copy `engine.mjs` into `apps/api/src/engine/` and port it; `pnpm spec:check` keeps both honest.

## 1. Numeric rules
- Integers only. Money and anything that can exceed 2^53 -> `BigInt` internally, decimal string on the wire.
- Division is **floor division on non-negative operands only**. Never divide a negative number (use `max0`).
- Units: `ppm` = 1/1,000,000, `bps` = 1/10,000, `milli` = 1/1000 of a point. USDC base units: 6 decimals.

## 2. Formulas
`attainment_ppm`
- higher_better: `floor(actual * 1e6 / target)`
- lower_better: `actual == 0 ? cap_ppm : floor(target * 1e6 / actual)`
- `target <= 0` or `actual < 0` -> error `validation_failed`.

`capped_ppm = clamp(attainment_ppm, floor_ppm, cap_ppm)`; `contribution_ppm = floor(weight_bps * capped_ppm / 10000)`.

`score_ppm = sum(contribution_ppm)`; `score_bps = floor((score_ppm + 50) / 100)` (round half up to bps).

`payout_curve`: points `[[score_bps, multiplier_bps], ...]`, x strictly increasing, y **non-decreasing** (validated; monotone curves prevent perverse incentives). Linear interpolation `y0 + floor((x - x0) * (y1 - y0) / (x1 - x0))`, clamped to the first/last y outside the range.

`gate`: `verified_ratio_bps >= gates.min_verified_ratio_bps`, else `multiplier_bps = 0` and `bonus_amount = "0"` (result still returned with `gate_passed:false`).

`bonus_amount = floor(target_bonus * multiplier_bps / 10000)`.

`tiered_commission` (plans with `kind: tiered_commission`): `base = floor(min(sales, quota) * rate_bps / 10000)`; `over = max0(sales - quota)`; `accelerated = floor(over * rate_bps * accelerator_bps / 1e8)`; `payout = floor((base + accelerated) * retention_bps / 10000)`; `attainment_bps = floor(sales * 10000 / quota)`. Currency is **whole USD**; `bonus_amount = payout * 1,000,000` (USDC base units). `score_bps = attainment_bps`, `multiplier_bps = gate ? 10000 : 0`.

`bug_credit` (milli-points), per fix: `v = weight_milli[severity]`, then `v = floor(v * impact_bps / 10000)`, `v = floor(v * share_bps / 10000)`, `v = 0` if `self_introduced`. Per severity tier: sort `v` descending; the first `full_credit_count` count in full, the rest count `floor(v * taper_bps / 10000)`; the tier sum is capped at `tier_cap_milli`. Total = sum of tiers. Result feeds any KRA whose `source == "bug_credit"` as its actual (so one P0 fix = 40,000 milli beats twenty P3 fixes = capped 10,000 milli). Severity must be set by someone other than the fixer; self-introduced bugs (SZZ-style flag) earn 0.

`carry_forward`: if a prior cycle FINAL score exists (the latest non-revoked scorecard of the previous cycle) and `history_weight_bps = w > 0`: `blended_bps = floor((cur_bps * (10000 - w) + prior_bps * w) / 10000)`, then the curve and bonus are computed from `blended_bps`. `w <= 5000`. Open items from the prior cycle (evidence in `disputed`/`reverted` that was never resolved) are surfaced as `open_items` flags for the approving manager; they do not change the math in v1.

`revision(target, paid, held, new_multiplier_bps)` (vault + backend must agree):
```
new_ent        = floor(target * new_multiplier_bps / 10000)
held_remaining = max0(new_ent - paid)
overpaid       = max0(paid - new_ent)        // offset against future payouts, never clawed back by force
forfeited      = max0(held - held_remaining)
extra_owed     = max0(held_remaining - held)
```
`payout_split(target, mult, holdback_bps)`: `ent = floor(target*mult/10000)`, `immediate = floor(ent * (10000 - holdback_bps) / 10000)`, `held = ent - immediate`.

## 3. Evidence -> actuals (aggregation)
- **Counted** statuses (feed actuals): `verified`, `provisional`, `vested`. Everything else (`unverified`, `disputed`, `reverted`, `superseded`, `rejected`, `shredded`) is **not** counted.
- **Candidate** statuses (denominator of the gate): `unverified`, `verified`, `provisional`, `vested`. `verified_ratio_bps = floor(10000 * counted_candidates / candidates)`, or 10000 if there are no candidates.
- Per KRA: collect `observations` with `metric_key == kra.metric_key` from counted evidence of that employee and cycle. `agg: sum` adds them, `agg: latest` takes the value of the observation with the greatest `(observed_at, evidence_id)`. No observations -> 0. KRAs with `source: bug_credit` use the bug-credit total instead.
- Evidence promotion rules (system, not LLM): items from `github|tickets|crm|hris` connectors become `verified` at ingest; `worklog`/`manual`/AI-drafted items stay `unverified` until a co-signer signs (-> `verified`) or a manager confirms them; a co-signer decline -> `rejected`.
- A `pr_reverted` item with `reverts_ref` moves the target to `reverted` (its observations stop counting) and a new scorecard version is proposed (`draft`). The previous attested version is superseded only when the new one is approved and attested.
- Lifecycle after attestation: `verified -> provisional` (when its scorecard is attested) `-> vested` (after `maturity_days`). `disputed` returns to its previous status on resolution.
- ML/AI output is never an `observation`. An AI draft can only create `unverified` evidence with `source: worklog`.

## 4. What must never happen
Float math, unordered iteration affecting results, locale-dependent formatting, `Date.now()` inside the engine (pass `as_of`), an LLM in the compute path, or a score derived from `unverified` evidence.
