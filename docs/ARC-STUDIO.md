# Building the bonus pool in Arc Studio

Arc's rules: **"Every Arc prize requires using Arc Studio as the starting point"**, with a **shareable Arc Studio
project URL** that judges can open, and **Studio shown in the demo**.

We submit to **"Best Smart Contracts with Advanced Stablecoin Logic, In Arc Studio" ($3,000)**. Its brief lists
programmable payroll, payment splitting, team payouts, and conditional escrow with dispute and automatic release.
That is this contract.

The existing `AttestationRegistry` / `BonusVault` (Foundry) stay as they are: the evidence anchors and per-scorecard
payouts. The **new pool contract below is built in Arc Studio**. The backend's agents (0G) propose allocations to it,
and HR approves them with World ID.

## Steps (about 20 minutes)

1. Open https://studio.arc.io, sign in, and create a new project named **Proofwork Bonus Pool**.
2. Paste the prompt below. Let Studio write the contract, write and run its tests, and fix anything that fails.
3. Ask Studio to **deploy to Arc testnet**. Note the contract address.
4. Ask Studio for a small **admin page** (connect wallet, create pool, view buckets and allocations) so the Studio
   project contains a working app as well. Our real UI stays in `apps/web`.
5. Grant roles from Studio (or tell me and I'll do it from the backend):
   - `ALLOCATOR_ROLE` → the review agent `0xB6b94f42AA5Bf066C28d97dDfc355A619a3905eF`
   - `APPROVER_ROLE` and `POOL_ADMIN_ROLE` → HR / payout key `0x0351C881633238E0E900755b50BB9258cDC9EF54`
   - `DISPUTER_ROLE` → the payout key as well, or an HR address you choose
6. Share the project (**Share → copy link**). Send me the **Studio URL** and the **contract address**.
7. Record a 20-second clip of Studio (prompt, tests passing, deploy) for the video.

## Prompt to paste into Arc Studio

```
Build a Solidity contract "BonusPool" for Arc testnet that settles in USDC (6 decimals, the Arc testnet USDC
ERC-20 at 0x3600000000000000000000000000000000000000). It is the payout engine of an HR product where AI agents
propose how a bonus pool is split and a human approves.

Roles (OpenZeppelin AccessControl): DEFAULT_ADMIN_ROLE, POOL_ADMIN_ROLE (HR creates and funds pools),
ALLOCATOR_ROLE (an AI agent proposes allocations), APPROVER_ROLE (HR approves), DISPUTER_ROLE.

Pools:
- enum Kind { YEAR_END_BONUS, BOUNTY, FREELANCE }
- createPool(bytes32 poolId, Kind kind, uint64 periodEnd, uint16 holdbackBps, uint32 disputeWindowSecs,
  bytes32[] bucketIds, uint256[] bucketBudgets): POOL_ADMIN only. Pulls sum(bucketBudgets) USDC from the caller
  with transferFrom. bucketIds are hashes of a department, peer cluster or project (for example
  keccak256("cluster:software.ic")). Emits PoolCreated and BucketFunded per bucket.
- topUp(poolId, bucketId, amount) to add budget.

Allocations (the agent proposes, HR approves):
- proposeAllocation(bytes32 poolId, bytes32 bucketId, address[] recipients, uint256[] amounts,
  bytes32[] evidenceHashes, bytes32 rationaleHash): ALLOCATOR only. The sum must be <= the bucket's remaining
  budget. evidenceHashes are per-recipient hashes of the review / attestation the amount is based on;
  rationaleHash is the hash of the agent's written rationale. Creates allocationId (incrementing), status Proposed.
  A new proposal for the same bucket supersedes the old one if it is not yet approved.
- approveAllocation(uint256 allocationId): APPROVER only. Status Approved; reserves the amounts from the bucket.
- rejectAllocation(uint256 allocationId, bytes32 reasonHash): APPROVER only.

Settlement:
- YEAR_END_BONUS: nothing is claimable before periodEnd. After periodEnd, each recipient (or anyone on their behalf)
  calls release(allocationId, index): pays amount * (10000 - holdbackBps) / 10000 immediately. The holdback becomes
  releasable after disputeWindowSecs via releaseHoldback(allocationId, index).
- BOUNTY and FREELANCE: no periodEnd lock; release pays in full immediately after approval (holdbackBps may be 0).
- dispute(allocationId, index, bytes32 reasonHash): DISPUTER only, during the window; freezes that line.
  resolveDispute(allocationId, index, bool pay): APPROVER only; pay = release it, otherwise return it to the bucket.
- closePool(poolId): POOL_ADMIN only, after periodEnd + disputeWindow; returns unreserved budget to the caller.

Views: getPool, getBucket(poolId, bucketId) -> (budget, reserved, paid), getAllocation(allocationId),
lineState(allocationId, index).
Events for every state change, including recipient, amount and evidence hash.
Use ReentrancyGuard and SafeERC20. Revert with custom errors.

Write Foundry-style tests covering:
- the happy path for YEAR_END_BONUS: create, propose, approve, release before periodEnd reverts, release after,
  holdback after the window;
- BOUNTY paying immediately;
- a proposal over budget reverts;
- non-allocator propose reverts;
- dispute then resolve both ways;
- double release reverts;
- closePool returning the unreserved remainder.
```

## Interface the backend calls

```
createPool(bytes32,uint8,uint64,uint16,uint32,bytes32[],uint256[])
proposeAllocation(bytes32,bytes32,address[],uint256[],bytes32[],bytes32) returns (uint256)
approveAllocation(uint256)
release(uint256,uint256)
releaseHoldback(uint256,uint256)
getBucket(bytes32,bytes32) view returns (uint256,uint256,uint256)
```

If Studio changes a name or signature, send me the ABI (Studio shows it) and I'll adapt the backend.
