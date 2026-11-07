# Proofwork: submission kit (ETHGlobal Mumbai 2026)

**One line:** Proofwork turns year-end bonus reviews from opinion into proof. Agents collect the evidence, code
computes the score, humans decide with World ID, and the chain proves it.

**Repo:** https://github.com/IshanJ9/Ethglobal26 · **Live demo:** https://nuke-elite-pregnant-xbox.trycloudflare.com (served from the team laptop via a Cloudflare tunnel; pick any persona to sign in) · **Video:** `<link>`
**Team:** `<names, Telegram, X>`

## Short description (for the form)

Bonus season is opaque: managers decide from memory, employees can't check the numbers, and AI tools make it
worse by inventing them. Proofwork splits the job into four layers. **Agents collect:** tool-calling agents on
0G Private Computer pull evidence from GitHub, tickets, HRIS and client co-signs (typed or dictated), sealed and
stored on 0G Storage. **Code computes:** a deterministic KRA engine scores each person inside their peer cluster.
**Humans decide:** every decision (approve, co-sign, anchor, acknowledge) is a World ID proof bound to the exact
hash being decided, and the review agent only runs after a World ID Agent Pass approval. **Chain proves:** scores,
reviews and payouts are anchored on Arc, USDC bonuses are released from an Arc Studio-built BonusPool, review
credentials and agent identities live on ENSv2, and employees can prove "my score is at least X" with a
zero-knowledge proof without revealing it.

## Architecture

The mermaid diagram is in the README (`## Architecture`). Export: paste it into https://mermaid.live and download
PNG for the Arc form.

---

## ENS: Best Use of ENSv2 (Sepolia)

- **Subname registry + Enhanced Access Control as the org chart.** `proofwork-demo.eth` has a PermissionedRegistry
  (`0xea57403f…7b40`) for people and agents, one **PermissionedResolver per department**, and EAC roles: the org
  admin holds everything; HR can register, unregister, renew and set any record; each department manager can set
  only `title`, `cluster`, `status`, only in their own department; employees write nothing. Enforced by the ENS
  contracts, not our backend: `/org/access` simulates 13 allow/deny cases live and sends a real edit (Elena edits
  Ben ✓, Ben edits Chen ✗ reverted by the resolver).
- **Aliasing:** `head.software` → `elena`, `hrbp.people` → `jon` (`linkToNode`).
- **Review credentials:** every anchored review mints `r-<hash>.proofwork-demo.eth` to the employee:
  non-transferable, expiring (1 year), revocable by HR, with `review_hash`, `anchor_tx`, `cluster` records that the
  review page checks live (e.g. `r-e682b1af.proofwork-demo.eth`).
- **Agents as namespaces:** `review-agent.` and `kra-agent.proofwork-demo.eth` have their own resolvers and
  permissions; the review agent self-publishes its prompt hash as a text record and every review shows
  "✓ matches the agent's ENS prompt record".
- **Not hard-coded:** the directory resolves 48 names / 266 records live through the Universal Resolver.
- Addresses: `deployments/ens.json`, `deployments/ens-roles.json`; scripts in `contracts/scripts/`.

## World: World ID Agent Pass

- **Protected action:** the 0G review agent reads an employee's sealed evidence and writes their bonus review.
  It cannot start until a verified human approves *that exact request* (operation hash of employee + cycle).
- **Journey:** HR clicks *Prepare review* → device authorization at auth.world.org (QR) → the person approves with
  a passkey / World App → our backend validates the ID token (RS256 JWKS, issuer, audience, `acr` = Orb,
  `auth_time` freshness, operation hash, one use, 10-min TTL) → the agent runs → the review records the pass.
- **Failure paths:** reuse of the same approval → 401 "already used"; cancel and expiry → the agent never runs.
- **Secure backend:** client secret only on the API; the browser never sees tokens.
- **Debrief:** `docs/WORLD-AGENT-PASS.md` (time to first success, friction, missing docs, top improvement).

## World: Best Use of IDKit

- **Trust moments:** approving a scorecard (manager), co-signing a client claim (external client), anchoring a
  review (HR), acknowledging a review (employee). Each is a decision about someone's pay.
- **Why Proof of Human (Orb) is the minimum sufficient credential:** we don't need to know *who* the person is (the
  org already knows its staff; the client is named on the claim), only that a single real human made this decision
  and can't make it twice or hand it to a bot. Passport/NFC would leak identity we don't need; a selfie check
  wouldn't stop one person running many accounts.
- **Binding:** the IDKit signal is the hash being decided, and every action is per object (`pw-approve-scorecard-<id>`),
  so one proof approves exactly one thing; nullifiers are consumed server-side.
- **Alternative paths:** a replayed proof → 401; a wrong signal (hash changed after review) → rejected; cancel →
  nothing happens.
- **Debrief:** World ID 4.0 nullifiers are single-use per (app, action), which broke "one manager approves many
  scorecards" until we moved to per-object actions; this wasn't obvious from the docs (CHANGE_REQUESTS.md CR-006).

## Arc: Best Smart Contracts with Advanced Stablecoin Logic, in Arc Studio

- **Studio project:** https://studio.arc.io/share/solidity-contract-compiler-manager-qnzq3xhzoh
  (live dashboard: https://arc-studio-c8dc24d0ad1f4a509f481b8a.vercel.app)
- **BonusPool `0x42d450d6dcaf980609ac23ea2639cabdfb8898cf`**, written, tested and deployed in Studio from a Circle
  developer-controlled wallet. Pools per cycle and kind with one bucket per cluster; multi-step settlement:
  the AI agent (ALLOCATOR_ROLE, its own key) proposes, HR (APPROVER_ROLE) approves, USDC is released.
  **Conditional logic:** year-end bonuses lock until the period ends, with a 20% holdback and a 7-day dispute
  window; bounties and freelance pay on approval. Live: allocation #1, 10 transactions, 6 USDC releases.
- **Also on Arc:** AttestationRegistry `0x9ab5E0cc…5112` (evidence roots, score and review anchors), BonusVault
  `0x3FE940C4…c97F` (per-person payouts with holdback and disputes), ScoreThresholdVerifier `0x1907a282…6728` and
  ScoreProofRegistry `0x5ab3EFC2…aE66` (Groth16 proofs verified and recorded on chain).
- **Honest note:** BonusPool is the contract built in Studio; the earlier contracts were written in Foundry.

## 0G: Build with 0G Private Computer

- **0G is the product's engine:** tool-calling agents (evidence agent, bonus allocation agent, promotion agent)
  run on `0gm-1.0` with function calling; reviews and claim drafts are written there; dictation runs on
  `whisper-large-v3`. Every record shows its 0G request ID.
- **Sealed storage:** every evidence item is encrypted (AES-GCM, per-record key) and stored on 0G Storage; the
  review reads it back by root, checks the Merkle proof and recomputes the commitment before reasoning.
- **What breaks without 0G:** the agents can't choose what to collect, nobody writes the review or the bonus
  split, and the employee's private work data would have to go to a public AI API in plain text.
- **Why come back:** every employee files evidence through the year (a 10-second voice note after a client call),
  managers and HR use it every cycle.

## Zero-knowledge (cross-track)

Groth16 circuit `score_threshold` (Poseidon commitment anchored on Arc by HR). The employee proves "score ≥ X"
in the browser in ~300 ms; anyone verifies it locally, on Arc's verifier, against the anchored commitment, and in
ScoreProofRegistry. A false claim has no valid proof.
