# Proofwork frontend: what the UI needs (for a fresh mockup)

Written Fri 6 Nov 2026 from the API (spec 1.2.0, `spec/openapi.yaml`) and the agreed flows, **not** from the current
`apps/web` pages. It says what each screen must show and do; layout and visual design are open.

---

## 0. Updates (Fri 6 Nov): landing page, design rules, sponsors

### 0.1 The landing page replaces the slide deck
A judge should understand the whole project from the landing page alone: no PPT. It is public (no login) and is the
first thing anyone sees. Suggested sections, top to bottom, each reachable from a sticky top nav:

1. **Hero.**
   - One sentence on what Proofwork is.
   - The tagline: *Agents collect, code computes, humans decide, chain proves.*
   - Two buttons: **Try the demo**, which goes to the persona picker, and **Verify a record**, which goes to the public verify page.
2. **The problem.** Bonuses and appraisals rest on evidence nobody can check:
   - informal work in chats and calls is invisible
   - the numbers are opaque
   - payouts can be quietly changed
3. **How it works.** The 7 steps from section 1a, with the diagram:
   - evidence comes in
   - the ledger keeps it private and tamper-evident
   - claims are AI-drafted and co-signed
   - the engine computes the score
   - a person approves and the chain records it
   - the vault pays
   - anyone verifies

   Show one short line per step, with "read more" expanding to the detail.
4. **Sponsor integrations.** One card per sponsor (section 0.3): what we use, where it appears in the product, and live or mock status with proof links.
5. **Live proof.** Links anyone can click:
   - the Arc explorer for the registry and vault contracts
   - an example attestation tx
   - the ENS names on Sepolia
   - the verify page, preloaded with a demo scorecard ID
6. **Privacy and honesty.** What is on chain:
   - commitments, Merkle roots, pseudonymous IDs, multipliers
   - never names or raw scores

   What is off chain: encrypted records that can be deleted. What is mocked today.
   Never claim "GDPR compliant" or "ZK-proven".
7. **Demo walkthrough.** The 6-step click path from section 6, each step with a "do it" button that logs in as the right persona.
8. **Architecture and repo.**
   - the monorepo layout: `apps/api`, `apps/web`, `apps/ingest`, `contracts`, `spec`
   - the frozen spec and contract-guard idea
   - the test counts
   - a GitHub link
9. **Roadmap.** Real SSO, World Agent Pass, more connectors (Slack, Jira), WhatsApp Business API, ZK proofs. Mark all of these as roadmap, not built.
10. **Team and footer.**

Content the landing page needs from the API: `GET /v1/config/public`, which supplies the mode badges, contract addresses, explorer URL, the agent's ENS name and the chain scale. Everything else is static copy.

### 0.2 Design rules
- **Clean and easy to navigate:**
  - one primary action per screen
  - a persistent top nav: Home / Demo / Verify / How it works, plus the persona switcher once logged in
  - breadcrumbs on detail pages
  - hashes and proofs collapsed under a "Proof" disclosure by default
- **Light and dark mode:**
  - Follow the system setting by default, with a toggle in the header that remembers the choice.
  - Both themes need the same contrast. Check that status badge colours, MOCK/LIVE labels and charts read in both.
  - Status must never rely on colour alone: always add text or an icon.
- **No unnecessary animation:**
  - No decorative motion, parallax or animated backgrounds.
  - Motion only to show a real state change, for example a claim moving to verified or a run's tool calls arriving, and kept short.
  - Respect `prefers-reduced-motion`.
- Readable on a laptop projector, with large enough type and generous spacing. The co-sign page must work on a phone.

### 0.3 How each sponsor is integrated (must be obvious on the landing page and in the product)

| Sponsor | What we use | Where it shows in the product | Status (Fri 6 Nov) | Proof to link |
|---|---|---|---|---|
| **Arc** | Two contracts on Arc testnet (chain 5042002), paying in native USDC: **AttestationRegistry**, which stores evidence Merkle roots and score attestations with revoke/supersede, and **BonusVault**, which funds each cycle in USDC and handles release, 20% holdback with maturity, revision forfeits and disputes. The backend is the only sender, with two role keys. | Scorecard: the attestation tx. Payout: paid, held and forfeited, each with a tx. Evidence: "anchored on Arc". Verify: the "root anchored on chain" check. | **Live**: attest, release and revision ran on Arc. The vault runs at 1/10,000 of real amounts (testnet funding), and the UI labels that. | Registry `0x9ab5E0cc44b7336DE8306c9f2F91d7cC832d5112`, vault `0x3FE940C4F1464d769795d24157037BEf7C3ec97F` on `explorer.testnet.arc.io` |
| **World** | World ID step-up so a unique human makes each decision: managers approve scorecards (action `pw-approve-scorecard`), and co-signers can confirm claims (action `pw-cosign-claim`). Each proof is bound to the action and challenge, and nullifiers stop replays. The approval proof hash goes on chain inside the attestation. | Approval screen (the World ID button). Co-sign page (the World ID option). Scorecard proof panel (approval proof hash). | **Mock** today (labelled). The live verifier for the World ID 4.0 cloud API is built and waits on the mentor's answer about request signing (CR-002). Agent Pass is roadmap. | World app ID once live; the verifier design in `docs/api-notes.md` |
| **0G** | **Private Computer**: claim drafting runs as TEE-verified inference through the 0G router. The trace records provider, model, TEE verified and request ID. **Storage**: an encrypted copy of every evidence record is uploaded, with its root stored on the record. | Claim detail: the "AI drafted on 0G" trace with the TEE badge. Evidence detail: 0G replica status and root. | **Mock** today (labelled). Both adapters are built; waiting for the API key and testnet tokens. `zerog:probe` switches them on. | Request IDs and storage roots once live |
| **ENS** | Human-readable identity on Sepolia under `proofwork-demo.eth`. The agent is `kra-agent.proofwork-demo.eth`, with text records for role, spec, policy hash and URL. People are `asha.proofwork-demo.eth` and so on. A name is shown only after it is checked to resolve to that exact wallet. | Everywhere a person or the agent appears: headers, team list, run traces, co-sign requester. | **Live**: agent plus 5 of 10 people verified. | The names on a Sepolia ENS explorer (for example `sepolia.app.ens.domains`) |

Rule: every sponsor card and every proof in the product carries the **LIVE** or **MOCK** label taken from
`/v1/config/public` (`chain_mode`, `world_mode`, `zerog_mode`; ENS is live when `ens.network` is not `none`), so the
landing page can never overclaim.

## 1. The story the UI has to tell

> **Agents collect, code computes, humans decide, chain proves.**

1. Evidence arrives:
   - **Official** evidence comes from GitHub, tickets, the CRM and HR systems, and counts immediately.
   - **Informal** evidence comes from Telegram, WhatsApp exports and claims typed in the app. It counts only after a co-signer signs.
2. A deterministic engine turns that evidence into a **scorecard**: per-KRA lines, a score, a multiplier and a bonus. The AI never produces a number.
3. A manager **approves** the scorecard with a World ID step-up. It is then **attested** on the Arc chain.
4. The **bonus vault** releases USDC, holding part of it back. Revisions and disputes move money with a full trail.
5. Anyone can **verify** a piece of evidence, a claim or a scorecard against the chain, without seeing private data.

## 1a. How it works (the backend, in plain terms)

This explains what happens behind each screen. It can also be the copy for a "How it works" page.

```
 GitHub / tickets / CRM / HR ──► connectors ─┐                       ┌─► Arc: AttestationRegistry
 Telegram / WhatsApp / in-app ─► claims ─────┤                       │     (Merkle roots, score attestations)
        (AI draft on 0G, co-signed)          ▼                       │
                                   Evidence ledger ──► Engine ──► Scorecard ──► World ID approval ──► Attest
                            (encrypted, committed,   (plain code,                                     │
                             hash-chained, 0G copy)   no AI)                                          ▼
                                                                                         Arc: BonusVault (USDC)
                                                                                    release · holdback · revise · dispute
```

### Step 1. Evidence comes in
- **Official sources** come through connectors:
  - GitHub merged PRs and reviews
  - ticket and incident data
  - CRM deals and pipeline
  - HR records
  
  These are systems of record, so they enter the ledger as **verified**. The evidence agent runs five fixed, deterministic connectors (git, tickets, crm, hris, worklog) and records a trace of what each one returned.
- The **GitHub webhook** checks GitHub's signature on every event, so forged events are rejected. It maps merges, approved reviews, closed bug issues and reverts onto the evidence types the engine scores. The same event sent twice is stored once.
- **Informal sources** become **claims**:
  - text in the app
  - Telegram messages and forwards
  - WhatsApp exports

  The Telegram bot masks phone numbers, emails, UPI, card, Aadhaar and PAN numbers before anything leaves the chat, and replaces chat names with "Person 1, 2…". A claim never counts on its own (step 3).

### Step 2. The evidence ledger keeps it private and tamper-evident
- **Encryption:** every record is encrypted with its own key. Each record key is in turn encrypted under a master key, so deleting a record's key makes the record unreadable forever ("crypto-shredding").
- **Commitments:** every record gets a **commitment**: a salted hash. It proves the record existed without revealing it.
- **Hash chain:** records are chained, each one including the hash of the one before. Editing any past record breaks the chain, and the verify check catches it. The audit log is chained the same way.
- **Anchoring on Arc:** commitments are grouped into batches. Each batch's Merkle root, one hash covering the whole batch, is **anchored on the Arc chain**. Anyone can then prove a record was in a batch.
- **0G copy:** an encrypted copy is uploaded to **0G Storage** as an off-site backup. The database stays the source of truth.

### Step 3. Claims: the AI drafts, people sign
1. The employee writes what they did. That text is treated as untrusted data.
2. The AI, running on **0G Private Computer** in a TEE (secure hardware), turns it into a structured draft: kind, summary, date, duration, counterparty.
   - It flags suspected prompt injection, low confidence, or fields it had to infer.
   - It never sets a KRA, an amount, or a state.
3. The employee checks the draft and **signs it** (an EIP-712 wallet signature). The signature covers commitments to the claim and the excerpt, not the raw text.
4. A one-time magic link goes to the co-signer, for example the client CFO. They see just that claim, with the AI flags, and sign or decline.
5. Only a co-signed claim turns into evidence that counts.

### Step 4. The engine computes the score (plain code, no AI)
- **Formula:** each plan is a published formula, and its hash is part of the proof.
- **Per KRA:** the engine sums the counting evidence, compares it with the target, and caps attainment at a limit. It applies the KRA's weight. Reverted work is removed, and bug fixes earn credit by severity.
- **Gate:** if too little of the evidence is verified, the multiplier is 0. This blocks bonuses built on unverified claims.
- **Multiplier:** the score maps to a multiplier through a payout curve that only goes up, so a higher score never pays less.
  - **Bonus = target × multiplier.**
  - Sales plans use tiered commission instead: base rate, accelerator, retention.
- **Carry-forward:** the previous cycle's score can be blended in.
- **Reproducible:** integer maths only, so the same inputs always give the same score. That lets anyone recompute it.

### Step 5. A person decides, the chain records it
- **Scorecard:** a scorecard is a saved result with a version number.
  - If evidence behind it is later reverted, it is flagged **needs revision**.
  - A revision creates v2, with a diff against v1.
- **Approval:** the employee's manager or HR approves with a **World ID step-up**, which proves a unique human pressed the button. Nobody can approve their own scorecard.
- **Attestation:** once approved, the backend **attests** on Arc. On chain this records:
  - a pseudonymous subject ID (a hash of a secret, the employee and the cycle, never a name)
  - the score commitment
  - the evidence root
  - the formula hash
  - the approval proof hash
  - the multiplier

  A revision **supersedes** the old attestation, and the old one is revoked.

### Step 6. The vault pays in USDC
- **Funding:** the **BonusVault** on Arc holds USDC per cycle.
- **Release:** pays out the entitlement and **holds back a share**: 20% for 90 days on the engineering plan.
- **Revision:** a revision downwards forfeits the difference back to the cycle, for example 474 USDC. A revision upwards pays the extra.
- **Dispute:** a manager can **dispute**, which freezes the payout. HR **resolves** it by releasing or forfeiting.
- **Only the backend sends transactions,** using two separate role keys: one to anchor and attest, one for payouts.
- **On testnet:** the vault runs at 1/10,000 of real amounts, and the UI says so.

### Step 7. Anyone can verify
- **Verify** takes an evidence item, claim or scorecard ID and re-checks it against the chain:
  - commitment
  - Merkle proof
  - anchored root
  - not revoked
  - both signatures
  - hash chain
  - formula hash
  - whether the item was shredded
- **Privacy:** it needs no login and reveals nothing private. With a reveal (value plus salt), it also proves the content matches.

### Identity
- **People:** employees and the agent have **ENS names** on Sepolia (`asha.proofwork-demo.eth`, `kra-agent.proofwork-demo.eth`). A name is shown only if it resolves to that exact wallet.
- **Agent:** the agent's ENS records publish its role and policy hash.

### What is real today and what is mocked
- **Live:** Arc chain (attest, release, revision and verify all ran live), ENS.
- **Mocked, and labelled MOCK in the UI:**
  - 0G AI and storage: waiting for keys
  - World ID: waiting for the mentor's answer on 4.0 request signing

## 2. Who uses it

| Persona (dev login) | Role | Main jobs in the UI |
|---|---|---|
| Asha Rao `p_dev_a`, Ben `p_dev_b`, Chen `p_dev_c` | employee (software) | See own score, evidence and claims. File claims and ask for co-signs. Can run the agent and draft their own scorecard, but never approve it. |
| Farid `p_ae` | employee (sales, commission plan) | See own commission scorecard. Can't file claims (plan has no co-signable KRA). |
| Hiro `p_mkt_exec` | employee (marketing) | See own scorecard. Can't file claims. |
| Elena `p_eng_mgr`, Grace `p_sales_mgr`, Isha `p_mkt_mgr` | manager | Team view, start agent runs, create scorecards. Approve, deny, revise and attest them, release payouts, dispute (for their reports only). |
| Jon `p_hr` | hr | Everything a manager can do across the org, plus resolve disputes, shred evidence, read the full audit log. |
| Karan `p_client_cfo` | external_cosigner | Sees only the one claim behind a magic link, then signs or declines. Never sees the app shell. |
| Anyone (no login) | public | The verify page. |

**Access rules the UI must respect:**
- Employees see only themselves.
- Managers see their reports. HR sees everyone.
- Anyone who can see an employee can run the agent and create a scorecard for them, including the employee themself.
- Only their manager or HR can approve, attest, release, revise or dispute. Nobody approves their own scorecard.
- Other people's data comes back as 404, not 403, so treat it as "not found".

## 3. Things on every screen

- **Persona switcher / login.** Dev mode lets you pick any of the 10 personas (`POST /v1/dev/login`). The UI must handle SSO mode, where this doesn't exist.
- **Mode badges.** Use `GET /v1/config/public`:

  | Field | Values |
  |---|---|
  | `chain_mode` | `mock` or `live` |
  | `world_mode` | `mock` or `live` |
  | `zerog_mode` | `mock` or `live` |

  - Anything mocked must be visibly labelled MOCK wherever its proof is shown: tx hashes, World results, AI traces.
- **Spec handshake.** Every response carries `X-Spec-Version`. On a major-version mismatch, show a blocking banner.
- **On-chain scale note.** When `chain.amount_divisor` is greater than 1, show "On-chain amounts scaled 1:N" next to any amount or explorer link. Live Arc runs at 1:10,000.
  - The API always returns full-scale amounts, so the explorer shows each amount divided by N.
- **ENS names.**
  - People: show `ens_name` (for example `asha.proofwork-demo.eth`) when the API sends it. Otherwise show the short wallet address.
  - Agent: shown as `kra-agent.proofwork-demo.eth`, from `config.agent`. Its role and policy are text records on that name, which the UI reads itself; the API doesn't send them.
- **Explorer links.** Use `explorer_url` / `chain.explorer_base_url` for tx hashes and addresses. In mock mode, show "mock tx" with no link.
- **Number formats:**

  | Type | Unit in the API | Example |
  |---|---|---|
  | Amounts | strings in base units, 6 decimals | `"4463500000"` → 4,463.50 USDC |
  | Scores | bps | 8571 → 85.71% |
  | KRA lines | ppm | 1,000,000 = 100% |
  | Multiplier | bps | 10000 = 1.00× |
- **Errors.** Every error is `{error:{code,message,details}}`. Each code needs a human message. Examples:

  | Code | Meaning |
  |---|---|
  | `approval_required` | needs a World step-up |
  | `grant_closed` | link expired or used |
  | `chain_error` | carries `details.revert` |
  | `rate_limited` | too many requests |
  | `gate_failed` | the verified-evidence gate wasn't met |
- **Retries.** Send one `Idempotency-Key` per user action, and reuse it on retry.

## 4. Screens

### 4.1 Login / persona picker
- Pick a persona; show their role, department and ENS name.
- One-click "demo mode" entry points can come from here, for example "I am Asha" or "I am the client".

### 4.2 Employee home (`p_dev_a` and others)
- **Current cycle score:** the latest scorecard, with score, multiplier, bonus, and status (draft / pending_approval / approved / attested…).
- **Evidence feed:** `GET /v1/evidence`.
  - Each item shows its source (github, tickets, crm, hris, cosign, manual, worklog) and its status.
  - Make it clear which items count and which are pending.
- **My claims:** `GET /v1/claims`, grouped by state.
- **Payout:** paid, held back and maturity date (see 4.9).
- **Primary actions:** "File a claim", plus "Connect Telegram", which shows how to link the bot.

### 4.3 File a claim (`POST /v1/claims`)
- **Inputs:**
  - the KRA, chosen only from KRAs whose source is `cosign`, `worklog` or `manual`, from the plan
  - free text, up to 4,000 characters
  - the co-signer's wallet address and label
  - the cycle
- **What the user should know:**
  - The text is untrusted: the AI turns it into a structured draft.
  - Sales and marketing plans have no claimable KRA, so show an empty state that explains why.

### 4.4 Claim detail (`GET /v1/claims/{id}`)
- **State timeline:**
  - normal path: drafted → pending_cosign → verified
  - other outcomes: declined, expired, disputed, rejected
- **AI draft** (`body`):
  - kind, summary, date, duration, counterparty
  - `evidence_excerpt`
  - `ai_flags`, shown as warnings: `prompt_injection_suspected`, `low_confidence`, `fields_inferred`
  - the inference trace: provider 0G or mock, model, TEE verified true/false/null, request ID
- **Edit draft:** `PATCH /draft`, only while drafted.
- **Sign:** `GET /signing-package` returns EIP-712 typed data, with commitments the user can check themselves. The wallet signs, then `POST /submit`.
- **Request co-sign:** `POST /cosign-grants`, choosing `world_id` or `magic_link_wallet`.
  - The response contains the magic link `url`. It's shown **once**, so offer copy, share and QR.
  - One live grant per claim: a new grant revokes the old one.

### 4.5 Co-sign page, for external people (`/cosign#token=…`)
- The token is in the URL fragment and is sent as the `x-cosign-token` header. Use a minimal shell: no navigation, no other data.
- **Content** (`GET /v1/cosign/view`):
  - who is asking
  - the claim body and excerpt
  - `ai_flags`, so the co-signer sees injection warnings
  - the typed data to sign
  - the expiry time
- **Actions:**
  - Sign with a wallet (`POST /cosign/sign`), plus World ID when `auth_method` is `world_id`.
  - Decline with a reason (`POST /cosign/decline`).
- **Every later visit** returns 410 `grant_closed`. Show a clear "this link is used or expired" screen.
- **Must work well on a phone:** the demo shows this on a phone.

### 4.6 Evidence detail (`GET /v1/evidence/{id}`)
- **Details:** source, kind, ref (for example `gh:acme/core#101`, linked to GitHub), observed time, and observations (metric and value).
  - Bug items also have severity, share and self-introduced.
- **Status chip**, one of 9 values: unverified, verified, provisional, vested, disputed, reverted, superseded, rejected, shredded.
- **Links:** reverts, supersedes, or the claim that produced it.
- **Proof:**
  - commitment, batch ID and Merkle proof, with "anchored on chain" status and a link
  - the hash-chain position (seq, prev_hash, event_hash)
- **0G replica:** status none / pending / stored / failed / shredded, plus the root.
- **HR only:** a **Shred** button (`POST /shred`, which deletes the encryption key).
  - The item stays as a hash, and verify still proves it existed.
  - The UI must explain that "shredded" is permanent.

### 4.7 Team view (managers and HR; employees see the same for themselves)
- **Employee list** (`GET /v1/org/employees`): each person's latest score, status, `needs_revision` flag, open claims and payout state.
- **Run the evidence agent:** `POST /v1/runs` then `GET /v1/runs/{id}`, shown as a live trace:
  - the tool calls (git, tickets, crm, hris, worklog) with OK/fail and how many items each produced
  - the agent's identity (ENS name and address, agent_pass)
  - the inference record
- **Compute / create a scorecard:** `POST /v1/scores/compute` previews; `POST /v1/scorecards` saves a draft.

### 4.8 Scorecard detail (`GET /v1/scorecards/{id}`)
- **Header:** employee, cycle, version, status.
  - Status values: draft, pending_approval, approved, denied, attested, superseded, revoked.
- **One line per KRA:**
  - actual vs target, attainment, cap, weight, contribution
  - the evidence IDs behind it, which click through to the evidence
- **Summary:**
  - score, verified ratio
  - **gate passed?**
  - multiplier, bonus amount
  - carry-forward: prior score, weight, blended score
  - open items, warnings
- **Plan-specific blocks:**
  - bug credit tiers
  - commission (sales: attainment, base, accelerated, payout)
- **Proof:** formula hash, inputs hash, evidence root, score commitment, subject ID (pseudonymous), and the attestation (ID, tx, explorer, chain mode).
- **`needs_revision` banner:** evidence was reverted after the score was computed. A manager's "Revise" (`POST /revise`) creates v2.
- **Version history and diff** (`GET /diff/{other}`):
  - score delta, multiplier delta, bonus delta
  - which lines changed
  - evidence added or removed
- **Actions by role:**
  - request approval
  - attest (`POST /v1/chain/attest`)
  - go to payout

### 4.9 Approval (`/v1/approvals`)
- The manager sees the scorecard summary and approves with a **World ID step-up**.
  - The step-up is bound to `world_action` `pw-approve-scorecard` and the `challenge`.
  - Then `POST /approvals/{id}/complete`.
- **Deny** with a comment, or **cancel**.
- **Afterwards:** show the approval proof hash, who decided, and when.
- **Mock vs live:** with `world_mode=mock`, the step-up is simulated and must say so.

### 4.10 Payout (`GET /v1/payouts/{scorecard}`)
- **Status:** none → registered → active → disputed → closed.
- **Breakdown:** target bonus → entitlement → **paid now** / **held back** / forfeited / overpaid, plus the maturity date for the held part.
  - Show the on-chain scale note when relevant.
- **Actions:**

  | Action | Who |
  |---|---|
  | **Release** (`/release`) | manager or HR |
  | **Release holdback** after maturity | manager or HR |
  | **Dispute** with a reason | manager or HR |
  | **Resolve** (release or forfeit) | HR only |

  - Every action shows the tx hash and explorer link.
- **After a revision:** v1 and v2 show the same payout, because the newer attestation governs. Show the forfeit, for example "474 USDC forfeited after revision".

### 4.11 Verify, public (`POST /v1/verify`)
- **Input:** kind (evidence / scorecard / claim) and ID. Optionally, paste a reveal (value plus salt) to check the commitment too.
- **Output:** an overall OK and a checklist, with each check's detail:
  - commitment matches
  - Merkle proof valid
  - root anchored on chain
  - attestation not revoked
  - employee signature valid
  - co-signer signature valid
  - hash chain intact
  - formula hash matches
  - evidence not shredded
- A great screen for judges: no login, plain language next to each check.

### 4.12 Audit log (`GET /v1/audit`)
- HR sees everything; others see only their own actions. Paginated (`after`, `limit` ≤ 100).
- **Each row:** time, actor, action (for example `chain.anchored`, `run.succeeded`, `dispute_resolved_forfeited`) and target.
- The log is hash-chained, so show an "intact" indicator.

### 4.13 Guided demo (optional but useful)
One page that walks the 3-minute story with buttons that switch persona and go to the right screen (see 6).

### 4.14 Peer clusters (`/clusters`; `GET /v1/clusters`, `GET /v1/clusters/{id}/board`)
- HR lands here after sign-in. Managers can open it too.
- **Cluster picker:** one chip per cluster (department × level), with its member count. Only clusters with five or more members are listed.
- **Cluster header:** the plan the cluster uses (its ENS name and plan hash), members, median score, middle half, spread.
- **Ranking:** each member's score inside the cluster. HR sees names; an employee sees only their own row.
- **Every KRA across the cluster:** per-KRA statistics, tagged "integer statistics, recomputable".
- **Action:** "Prepare a review" for a member, which goes to the new review (`/reviews/{id}`).
- **Rule to show:** people are never compared across clusters. A cross-cluster request returns `409 cluster_mismatch`.

### 4.15 Reviews list (`/reviews`; `GET /v1/reviews`)
- **Each row:** person, cycle, cluster, whether it is anchored, whether it is acknowledged, and Open.
- HR and the manager can prepare a review from a cluster (link to 4.14). An employee sees only their own reviews.

### 4.16 Review detail (`/reviews/{id}`; anchor and acknowledge endpoints)
The three-layer review. Each layer says who produced it.
- **Layer 1, KRA score inside the cluster** (code computes): the person against one same-cluster peer, with raw numbers taken from commitments.
- **Layer 2, context** (code computes): three past periods from HRIS reviews and ticket deadlines, with the trend. History never changes a score.
- **Layer 3, reasoning for the review meeting** (AI writes, inside 0G Private Computer). Show:
  - the vault read-back: items read from 0G Storage, and commitments matched or failed
  - the number check and the wording check
  - the reasoning agent's identity: its ENS name, system prompt hash and model
  - if the 0G answer failed a check, a clear note that this text was written by code instead
- **Agent Pass:** before the review agent can run, HR approves that exact run with World ID Agent Pass (OIDC device flow: QR code and user code). Show the checkpoint state and that each approval is single-use.
- **"Why this review can't be disputed"** (chain proves):
  - HR anchors the review hash on Arc with World ID (`pw-anchor-review`), shown as batch ID, tx and explorer link
  - the employee acknowledges it with World ID (`pw-ack-review`); only once, and a second attempt gets 409
  - the ENS review credential: expiring, non-transferable, and HR can revoke it

### 4.17 Organisation directory (`/org/directory`; reads ENS on Sepolia)
- Under `proofwork-demo.eth`: departments, clusters with their plan hash, people, agents with their prompt hash, and contracts (ENSIP-11).
- A name is shown as verified only after it forward-resolves to the expected address.
- Link to 4.18.

### 4.18 Who can edit what (`/org/access`; ENS resolver access control on Sepolia)
- **Hierarchy:** admin, HR, managers, the review-credential issuer, and the review agent.
- **Permission matrix:** a live simulation of who may set which record. For each cell, show allowed or reverted, and flag any unexpected result.
- **Try it:** send a real edit signed with the persona's demo key, then show the tx, or the access-control denial with its reason.

### 4.19 HR agents (`/agents`; `/v1/agents/bonus-allocation`, `/settle`, `/v1/agents/promotion-chat`, `/v1/voice/transcriptions`)
- **Bonus pool, allocation agent:** the agent on 0G proposes a split of the pool across the three review layers. HR approves, and USDC is released through the BonusPool built in Arc Studio. Show the run trace and each settlement tx.
- **Promotions, planning agent:** a chat with 0G function calling over the three layers, including backfill planning. Voice input is transcribed on 0G (whisper-large-v3).
- **Rule:** agents propose, HR decides, and payouts happen on chain.

### 4.20 Prove a score (`/prove`; `POST /v1/zk/proofs`)
- The employee proves "score ≥ X" with a Groth16 proof generated in the browser. The score and salt never leave the device.
- **Inputs:** private (score, salt; they stay on this device) and the statement (the threshold).
- **Output:** the proof, how long it took to generate, a shareable verifier link, and the proof recorded on Arc (ScoreProofRegistry).

### 4.21 Verify a score proof (`/prove/verify#…`, public)
- **No login.** Shows the statement, then each check: proof valid against the ScoreThresholdVerifier on Arc, and the commitment matches the attested scorecard.
- **Result:** "Valid proof" or "Proof NOT valid". It reveals nothing about the actual score.

## 5. State badges (one consistent vocabulary)

| Thing | States |
|---|---|
| Evidence | unverified · verified · provisional · vested · disputed · reverted · superseded · rejected · shredded |
| Claim | drafted · submitted · pending_cosign · verified · declined · expired · disputed · rejected |
| Scorecard | draft · pending_approval · approved · denied · attested · superseded · revoked |
| Approval | pending · approved · denied · cancelled · expired |
| Payout | none · registered · active · disputed · closed |
| 0G replica | none · pending · stored · failed · shredded |
| Agent run | queued · running · succeeded · failed |
| Mode | MOCK · LIVE (chain, World, 0G separately) |

Trust language for evidence: **Official** (system of record), **Pending co-sign**, **Co-signed**. Only Official and
Co-signed count toward a score.

## 6. Demo click path the design must make smooth

1. **Asha** files a claim, or sends one from Telegram. The AI draft appears with flags. She signs and gets the co-sign link.
2. **Karan (client CFO)** opens the link on a phone and signs. The claim becomes verified, and Asha's evidence gains a co-signed item.
3. **Elena (manager)** runs the evidence agent and watches the trace, including the ENS agent identity. She creates the scorecard and sees the KRA lines and gate.
4. Elena **approves with World ID**. The scorecard is **attested** and the tx appears. She **releases** the payout: paid now, held back, maturity date.
5. A merged PR gets **reverted**. The scorecard shows **needs revision**. Elena revises to v2, the diff shows the score drop, and the payout shows the forfeit.
6. **Anyone** opens Verify, pastes the scorecard ID, and sees every check pass. HR shreds an evidence item, and verify still proves it existed.

## 7. Where Telegram and GitHub show up in the UI

- The bot and webhook (`apps/ingest`) produce ordinary claims and evidence, so nothing new is needed in the API.
- **Badges:** claims don't carry their channel. The text starts with "Forwarded message…" or "WhatsApp chat, <date>", and evidence has `source: github` with a `gh:` ref. Use those to show a channel badge.
- **"Connect Telegram":** dev mode has no API for linking, because link codes are generated by a script. For the demo, show the bot's QR / t.me link.

## 8. Rules the copy and design must follow

- Never say "GDPR compliant" or "ZK-proven". Say "encrypted, deletable (crypto-shredding)" and "hash-committed, anchored on Arc".
- Never present a mock proof as verified. Every mock tx, World result and AI trace is labelled MOCK.
- **The AI never shows a score.**
  - The UI may say "AI drafted this claim".
  - It must never suggest the AI decided a number or an outcome.
- **On-chain amounts are scaled:** say so wherever an amount meets the explorer.
- **ENS names:** show only what the API (or a forward check) confirmed.
- **Chat evidence is unverified until co-signed:** show the "Pending" state honestly.

## 9. Open questions for the mockup

- **Wallet connection:** which wallet UX? Employees and co-signers sign EIP-712. Dev personas can use built-in demo keys.
- **World ID:** IDKit widget placement for approvals and `world_id` co-signs. Live mode waits on the World mentor answer (CR-002).
- **Branding, colour, and how much crypto detail to show by default.** For example, collapse hashes under "Proof".
- **Mobile:** the co-sign page must be mobile-first. Are the other screens desktop-only?
