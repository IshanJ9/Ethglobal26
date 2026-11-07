# Demo runbook (live services)

Before you start: the API runs on `:8787` with every mode live (chain, World, 0G, ENS, Agent Pass), and the web on
`:3000`. Switch personas on `/demo` (HR is Jon, the manager is Elena, employees are Asha and Ben, the client is the Acme
CFO). Have World App and your passkey phone ready. The database is the live one (backup in `apps/api/data/backup/`).

| # | Who | Where | What to show | Sponsor |
|---|---|---|---|---|
| 1 | Elena (manager) | `/team` → Asha → *Run agent* | The evidence agent plans its own tool calls on **0G** (`0G tool call call_…` on every connector); evidence is encrypted and stored on **0G Storage** | 0G |
| 2 | Asha | `/claims/new` | 0G drafts the claim from her notes; she signs and shares the co-sign link | 0G |
| 3 | Client | the co-sign link (`pnpm --filter @proofwork/api exec tsx scripts/cosign-live.ts` prints a fresh one) | "Where this came from: ✓ Stored encrypted on 0G Storage · read back just now"; signs with World ID | 0G, World |
| 4 | Elena | `/approvals/…` | Approve the scorecard with a **World ID** scan (bound to the scorecard hash) | World |
| 5 | Asha | `/scorecards/…` | Attested on **Arc**, payout from `BonusVault` with holdback | Arc |
| 6 | Jon (HR) | `/clusters` → tick Ben → *Prepare review* | **World ID Agent Pass**: QR, then auth.world.org/device, *Continue with a passkey*, Approve. Then the 0G review agent runs (about 20 s) | World, 0G |
| 7 | Jon | the review page | Three layers; number and wording checks; *anchor on Arc* with World ID; **ENS review credential** `r-<hash>.proofwork-demo.eth` (expiring, non-transferable, HR can revoke) | 0G, Arc, ENS, World |
| 8 | Ben | the same review | *I received this review* (World ID) | World |
| 9 | Jon | `/agents` | **Bonus allocation agent**: 0G tool calls over the three layers, then *Settle on Arc BonusPool* (built in **Arc Studio**; the agent proposes with its own key, HR approves, USDC released). **Promotion chat**: "one Senior Engineer moves to PM, keep headcount" → move + backfill | 0G, Arc |
| 10 | Asha | her scorecard → *Prove my score* | **ZK**: Groth16 in the browser, then the share link verifies locally, on Arc's verifier and against the anchored commitment; *Record permanently on Arc* | Arc |
| 11 | anyone | `/org/directory`, `/org/access` | 48 ENS names resolved live; the permission matrix (13 live checks); a manager edit that succeeds and a peer edit that the resolver reverts | ENS |
| 12 | anyone | Arc Studio | The BonusPool project: prompt, tests, deploy (20 s clip) | Arc |

## If something is slow

- **0G** reasoning takes about 20 s, and 0G Storage reads 3 to 25 s. Pages say when they fall back to the local copy.
- **Arc** public RPCs rate-limit (429). Writes retry across two RPCs.
- **World Agent Pass:** approve on the laptop page with *Continue with a passkey*. Doing the World App step on the same
  phone as the browser can stall. Approve in a **separate tab or on the phone** and keep the cluster page open: it
  polls the checkpoint and starts the agent. If that tab navigated away, re-open `/clusters` and click *Prepare
  review* again (the approval is single-use, so a fresh QR is expected).

## Live evidence already on chain (for the submission)

- Arc:
  - review anchor `0xad82…ea81`
  - ZK proof recorded in `ScoreProofRegistry` `0x5ab3…aE66`
  - BonusPool allocation #1: 10 transactions; agent `proposeAllocation` `0x8cb0…b775`
  - Ben's payout 0.35708 USDC
- ENS (Sepolia):
  - `r-8691f383.proofwork-demo.eth`
  - role resolvers (`deployments/ens-roles.json`)
  - the review agent's self-signed prompt record
- World: four IDKit actions, plus Agent Pass `apc_607d…` (Orb class, used once, a reuse refused)
- 0G: claim drafts, review reasoning, tool-calling runs (request ids on every record), 229 evidence items on 0G Storage
