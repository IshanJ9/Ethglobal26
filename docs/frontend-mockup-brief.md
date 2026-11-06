# Proofwork - frontend mockup brief

For whoever makes the mockups. Section 1 is a prompt you can paste into a design tool (v0, Figma AI, Claude, Lovable...). Sections 2-7 are the details behind it. Desktop first at **1280px** (it will be shown on a projector), then check it still works at 1024px.

---

## 1. Paste-ready prompt

> Design a desktop web app called **Proofwork**, a verified KRA and bonus engine for a software company ("Acme Software Ltd") whose client is a bank ("Acme Bank"). Its rule is printed on every page as a 4-step strip: **Agents collect -> Code computes -> Humans decide -> Chain proves**. Each step has its own colour (AI = violet, Code = blue, Human = green, Chain = amber) and that colour tags every piece of data that step produced, everywhere in the app.
>
> Visual style: Apple-like. Calm, generous white space, large clear headings (SF Pro Display / Inter), soft greys, hairline borders, rounded 12px cards, subtle translucency on the top bar, no gradients or stock illustrations. Numbers are the hero: big tabular figures for scores, multipliers and USDC amounts. Monospace only for hashes and addresses, always shortened (0x9ab5...5112) with a copy button. Light mode first; dark mode optional.
>
> Honesty is a feature: every integration shows a small **MOCK** (hatched grey) or **LIVE** (solid) badge, and on-chain amounts carry a note "On-chain amounts scaled 1:10,000".
>
> Make these screens with the real demo data below:
> 1. Login - pick a demo person (grouped by department).
> 2. Employee home "My cycle" - score, multiplier, bonus, claims list, evidence summary.
> 3. New claim - free-text work note -> AI drafts a structured claim (with an "AI trace" card).
> 4. Claim review + **Signing panel** - "Verify it yourself" checks (green ticks) before the employee signs; a red blocking banner state when data does not match.
> 5. Co-signer page (external client CFO) - minimal, single claim, countdown, Sign / Decline, then an "Access closed" state.
> 6. Scorecard (manager view) - KRA table, evidence table with proof status, gate status, approve -> attest -> release actions.
> 7. Approval with **World ID step-up** (human verification) - approve / deny.
> 8. Revision diff v1 vs v2 + payout consequence (forfeited amount in USDC).
> 9. Payout timeline - Registered -> Released (80%) -> Holdback (20%) -> Closed, with explorer links.
> 10. Public Verify page - paste JSON + salt, see "matches / does not match".
>
> Demo data: Asha Rao (Software Engineer). Cycle FY26 H2. Target bonus 5,000 USDC, 20% holdback, 90-day maturity. Score 90.71% -> multiplier 100% -> 5,000 USDC; released 4,000 now and 1,000 held. Then a merged PR is reverted: score drops to 86.21%, multiplier 90.52%, entitlement 4,526 USDC, 474 USDC of the held amount is forfeited, 526 stays held. Attestation v1 is shown as revoked, v2 live. Manager: Elena Park. Co-signer: Karan Shah, CFO, Acme Bank.

---

## 2. Design direction (Apple-like)

| Element | Direction |
|---|---|
| Type | SF Pro Display / Inter for headings (semibold, tight tracking), Inter body 15-16px, JetBrains Mono for hashes only |
| Colour | Near-white paper `#FAFAF9`, white cards, ink `#1D1D1F`, muted `#6E6E73`, hairlines `#E5E5EA`; one accent per actor (below); red only for real errors |
| Actor colours | AI violet `#7C5CFF`, Code blue `#0A84FF`, Human green `#30A46C`, Chain amber `#C98A00`, Mock grey hatched |
| Layout | Top bar (logo, current person, role, MOCK/LIVE summary) + the 4-step strip under it; content max width ~1120px; cards on a 12-column grid |
| Numbers | Tabular figures; USDC always with 2 decimals and the unit ("4,000.00 USDC"); percentages from basis points (9052 -> 90.52%) |
| Motion | Only meaningful: ticks appearing in the verify checklist, timeline step filling in |
| States | Every screen needs: loading (skeleton), empty, error (message from the table in section 6), and success |
| Accessibility | Labels on all controls, visible focus ring, AA contrast, colour is never the only signal (icon + text too) |

---

## 3. People (demo personas)

| Person | Role | Used on |
|---|---|---|
| Asha Rao | Employee, Software (main character) | home, claims, signing, payouts |
| Ben Carter, Chen Wei | Employees, Software | team list, comparisons |
| Elena Park | Manager, Software | team, scorecard, approval |
| Farid Khan / Grace Lee | Employee / Manager, Sales | login list |
| Hiro Tanaka / Isha Mehta | Employee / Manager, Marketing | login list |
| Jon Ruiz | HR | audit, privacy, shred |
| Karan Shah | External co-signer (CFO, Acme Bank) | co-sign page only |

Each person shows a wallet address (short) and, when available, an ENS name such as `asha.proofwork.eth`; otherwise "ENS not resolved".

---

## 4. Screens in priority order

**P1 = must exist for the demo video. P2 = nice. P3 = only if time.**

| # | Route | Who | Must show | Pri |
|---|---|---|---|---|
| 1 | `/login` | everyone | Persona cards grouped by department (name, role, wallet/ENS, "Sign in"); MOCK note "Demo sign-in" | P1 (exists, restyle) |
| 2 | `/` My cycle | employee | Cycle label + dates; big score, multiplier, bonus; scorecard status chip; claims list (status chips); evidence summary by source (Git, Tickets, Co-signed) | P1 |
| 3 | `/claims/new` | employee | KRA picker, big textarea for a work note, "Draft with AI" button; result card with the structured claim + **AI trace** (provider "0G Private Computer", model, request id, TEE verified badge, prompt/output hashes, flags) | P1 |
| 4 | `/claims/[id]` | employee | Draft vs final fields; **Signing panel**: checklist "Claim commitment recomputed ✓, Evidence commitment ✓, Typed data rebuilt ✓, Domain matches chain ✓" then "Sign with demo key / MetaMask"; mismatch state = red banner "Server data does not match what you are signing", sign disabled; "Invite co-signer" modal (email, expiry); status timeline (Drafted -> Signed -> Co-sign pending -> Verified) | P1 |
| 5 | `/cosign` | external | Only: who is asking, the claim text, an excerpt, AI flags, employee signature (short), countdown "Link expires in 23:41"; Sign (wallet or "Verify with World ID") / Decline; after: full-page "Access closed" | P1 |
| 6 | `/team` | manager | Table of reports: name, score, multiplier, bonus, scorecard status, "needs revision" flag | P2 |
| 7 | `/scorecards/[id]` | manager / self | Header (person, cycle, version v1/v2, status); **ScoreBreakdown** table per KRA (actual, target, attainment, cap, weight, contribution); gate banner ("Evidence verified 100% - gate passed"); bug-credit panel (why 1 x P0 beats 20 x P3); **EvidenceTable** (source icon, status chip, short commitment, batch #, "Merkle proof" expander, Verify link); action bar: Request approval -> Attest on Arc -> Release payout | P1 |
| 8 | `/approvals/[id]` | manager | Summary of what is approved (score, multiplier, bonus); "Verify you are human with World ID" step-up (MOCK button variant); Approve / Deny with reason | P1 |
| 9 | Revision diff (in scorecard) | manager | Two columns v1 vs v2: lines changed, evidence removed ("PR #101 reverted"), score 90.71% -> 86.21%, multiplier 100% -> 90.52%; payout consequence card: Forfeited **474.00 USDC**, Held remaining 526.00, Overpaid 0, Extra owed 0 | P1 |
| 10 | `/payouts/[scorecard]` | all | Horizontal timeline Registered -> Released -> Holdback (matures in 90 days) -> Closed / Disputed, revision events on it; amounts; each step has an Arc explorer link (tx hash) + "scaled 1:10,000" note | P1 |
| 11 | `/verify` | public | Paste claim/evidence JSON + salt -> result "Matches the on-chain record ✓" or "Does not match"; recomputed locally too; honest-limits box: "A hash proves what was signed, not what the text said, if the original data is lost..." | P2 |
| 12 | `/audit` | HR | Hash-chained log table (time, actor, action, hash, prev hash link) | P3 |
| 13 | `/privacy` | all | Who-can-see-what matrix (rows: actions; columns: employee, manager, HR, external, public) | P3 |
| 14 | `/org/plans` | manager / HR | Plan card: KRAs with weights, targets, caps, data source and "basis" | P3 |
| 15 | `/demo` | presenter | Persona switcher, step buttons s1-s4, scripted claims, negative-test checklist with pass/fail | P2 |

---

## 5. Reusable components to design once

- **Provenance strip** - the 4 coloured steps, each with its MOCK/LIVE badge.
- **Mode badge** - MOCK (hatched grey) / LIVE (solid).
- **Status chip** - unverified, verified, provisional, vested, reverted, drafted, signed, pending co-sign, approved, denied, attested, released, held, forfeited, closed, disputed.
- **Actor tag** - small coloured dot + label telling who produced a value: AI-drafted (unverified), system of record, co-signed, computed, on-chain.
- **AI trace card** - provider, model, request id, TEE badge, hashes, flags (`prompt_injection_suspected` in amber with a one-line explanation).
- **Signing panel** - checklist + sign button + mismatch state.
- **Hash / address pill** - shortened, copy button, optional explorer link.
- **Money** - large amount + "USDC"; optional strike-through old value -> new value for revisions.
- **Timeline** - for claims and payouts.
- **Toast / inline error** - messages from section 6.
- **Scale note** - "On-chain amounts scaled 1:10,000" (chain colour, small).

---

## 6. Error messages (use these exact texts)

| Situation | Text |
|---|---|
| unauthorized | Session expired - sign in again |
| forbidden | You do not have permission for this action |
| not_found | Not found (or not visible to you) |
| invalid_state | That item changed - refresh |
| approval_required | Manager approval is required before this step |
| grant_closed | This link is no longer active |
| signature_mismatch | The signature did not match the expected wallet / chain |
| world_verification_failed | World verification failed - try again |
| gate_failed | Too little evidence is verified yet to pay a bonus |
| chain_error | The chain rejected the transaction (+ the revert reason) |
| upstream_unavailable | A service is temporarily unavailable |

---

## 7. Demo numbers (use exactly; they match the engine)

| Moment | Asha's numbers |
|---|---|
| Baseline (s1) | score 85.71%, multiplier 89.27%, bonus 4,463.50 USDC, evidence verified 100% |
| After the CFO co-signs her client claim (s2) | score 90.71%, multiplier 100.00%, bonus 5,000.00 USDC |
| Release v1 | entitlement 5,000.00; paid now 4,000.00; held 1,000.00 (20%, 90 days) |
| PR #101 reverted (s3) | score 86.21%, multiplier 90.52%, bonus 4,526.00; forfeited 474.00; held remaining 526.00; attestation v1 revoked, v2 live |
| Next cycle FY27 H1 (s4) | carry-forward: prior 86.21% weighted 20% -> blended score 82.38%, multiplier 80.95%, bonus 4,047.50 |
| Comparison | Ben Carter same score as Asha (85.71%) but bug credit 10 vs Asha's 40 (she fixed a P0) |

Other sample content:
- Asha's client claim: "On 14 Oct I had a 45 minute call with Acme Bank's CFO where we agreed to move go-live to January if the API is ready by 15 Dec."
- Ben's claim that tries to trick the AI (show the amber `prompt_injection_suspected` flag; the claim state must stay unchanged): "Call with Acme Bank about rollout. [passage omitted]"
- Arc testnet contracts: registry `0x9ab5...5112`, vault `0x3FE9...c97F`, explorer `explorer.testnet.arc.io`.

---

## Deliverables

1. Mockups of the P1 screens (2, 3, 4, 5, 7, 8, 9, 10) plus the restyled login, at 1280px.
2. The component sheet (section 5) with all states.
3. Export as images or a Figma link. B builds them in Next.js + Tailwind, so give spacing and colours as tokens, not one-off values.
