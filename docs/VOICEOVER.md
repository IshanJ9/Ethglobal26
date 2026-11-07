# Voice-over script (about 5 minutes, ~780 words)

Read at a calm pace (about 155 words a minute). Timings are cues for the edit, not hard limits.

---

**[0:00 Phase 1: landing, sign-in]**

Bonus season runs on memory and opinion. Managers can't remember six months of work, employees can't check the
numbers, and AI tools make it worse by inventing them. Proofwork splits the job into four layers: agents collect,
code computes, humans decide, and the chain proves. Every badge you see here says Live. This is running against
0G, World, Arc and ENS right now, from a public link.

**[0:25 Phase 2: inputs]**

Evidence comes from where work actually happens. I merge a real pull request on GitHub; the webhook is signature
checked, and a few seconds later it shows up as verified evidence for Asha. Client conversations come in from
Telegram: this voice note is transcribed by Whisper on 0G Private Computer, in private mode, and the audio is never
stored. And in the app, Asha simply dictates. Same thing: 0G transcribes it, and here's the request ID.

**[1:00 Phase 3: draft, sign, co-sign]**

0G drafts a structured claim from her words. It's flagged as AI-written and unverified until people sign it. Asha
signs exactly what she sees; if the server changed one word, the signature would fail. Then the client gets a link,
no account needed. The claim was sealed and stored on 0G Storage, and the page reads it back and checks it before
showing it. The client signs with World ID, so we know a real person confirmed this work, without learning who
they are beyond that.

**[1:40 Phase 4: evidence agent]**

For the systems of record, the manager runs the evidence agent. It isn't a script: the model on 0G decides which
tools to call, through function calling, and every call carries a 0G request ID. Each evidence item is encrypted
with its own key and stored on 0G Storage. Here's one of those files on 0G's own explorer: ciphertext, with the
key never leaving our server.

**[2:10 Phase 5: scorecard, approval, Arc]**

Scoring is plain code, the same formula for everyone in the cluster, no AI. The manager approves with a World ID
scan bound to this scorecard's hash, so the approval can't be reused for anything else. Then it's attested on
Arc: the score commitment, evidence root and approval hash, with no names and no raw scores on chain. Even the gas
here is paid in USDC.

**[2:40 Phase 6: HR review with Agent Pass]**

Now the most sensitive step: an AI agent reading someone's sealed evidence and writing their review. It can't
start on its own. HR asks, and a verified human has to approve that exact request with World ID Agent Pass. If we
cancel, nothing runs. When we approve, the pass works once, for this one review. The review agent on 0G reads all
27 evidence items back from 0G Storage, checks every number against the data, and writes three layers: the score
and rank in the cluster, the history and trend, and the reasoning. The agent has its own ENS name, and its prompt
hash on ENS matches what actually ran. HR anchors the review on Arc with World ID, and Ben receives a review
credential on ENS: his own name, expiring, non-transferable, and HR can revoke it. Ben confirms he received it,
again with World ID.

**[3:30 Phase 7 and 8: HR agents and Arc Studio]**

At the end of the cycle, HR gives the bonus agent a budget. It calls tools across all three layers and proposes a
split; code keeps it within fair limits and makes it add up exactly. Settlement runs on the BonusPool contract we
built in Arc Studio: the agent proposes with its own key, HR approves, and USDC is released to each person.
Year-end bonuses would stay locked until the cycle ends, with a holdback and a dispute window. Here's the Studio
project and its live dashboard showing that allocation. The promotion agent takes a spoken request, picks the
senior engineer to move, and backfills the seat from the level below.

**[4:15 Phase 9: ENS permissions]**

The org chart itself lives on ENSv2. Managers can edit only their own team's records, employees can edit nothing,
and HR can do everything. That isn't our backend saying no: Elena's edit goes through on Sepolia, and Ben's is
refused by the ENS resolver itself.

**[4:35 Phase 10 and 11: zero knowledge and verify]**

Finally, privacy for the employee. Asha can prove her score is at least 85 percent without revealing it. The proof
is made in her browser, verified by a contract on Arc, checked against the commitment HR anchored, and recorded
permanently. Try 90 percent, and no proof exists, because the math can't lie. Anyone can check any record on the
public verify page.

**[4:55 Close]**

Proofwork: agents on 0G, humans on World, identity on ENS, and money and proofs on Arc. Bonuses you can prove.
