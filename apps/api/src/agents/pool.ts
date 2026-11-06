// Settles an agent's bonus allocation on the Arc Studio BonusPool (0x42d4…98cf, built, tested and deployed in Arc
// Studio from a Circle developer-controlled wallet). Four on-chain steps, each signed by the key that holds the role:
//   1. payout key (POOL_ADMIN): approve USDC + createPool(poolId, kind, periodEnd, holdback, window, [bucket], [budget])
//   2. review agent key (ALLOCATOR): proposeAllocation(poolId, bucket, wallets, amounts, evidenceHashes, rationaleHash)
//   3. payout key (APPROVER = HR): approveAllocation(id)
//   4. bounty / freelance: release(id, i) for every line now. Year-end: locked by the contract until periodEnd.
// Amounts are scaled by CHAIN_AMOUNT_DIVISOR (testnet funding), like every other payout in the app.
import { createPublicClient, createWalletClient, defineChain, fallback, http, keccak256, parseAbi, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { components } from "@proofwork/shared";
import { errors } from "../errors.ts";
import { isHr } from "../auth/auth.ts";
import type { AuditRepo } from "../db/audit.ts";
import type { DB } from "../db/index.ts";
import type { OrgRepo, Persona } from "../db/org.ts";
import type { Config } from "../config.ts";
import { iso, type Clock } from "../util.ts";

export type BonusAllocation = components["schemas"]["BonusAllocation"];
export type BonusSettlement = components["schemas"]["BonusSettlement"];

const USDC = "0x3600000000000000000000000000000000000000" as const;
const ABI = parseAbi([
  "function createPool(bytes32 poolId, uint8 kind, uint64 periodEnd, uint16 holdbackBps, uint32 disputeWindowSecs, bytes32[] bucketIds, uint256[] bucketBudgets)",
  "function proposeAllocation(bytes32 poolId, bytes32 bucketId, address[] recipients, uint256[] amounts, bytes32[] evidenceHashes, bytes32 rationaleHash) returns (uint256)",
  "function approveAllocation(uint256 allocationId)",
  "function release(uint256 allocationId, uint256 index)",
  "function nextAllocationId() view returns (uint256)",
]);
const ERC20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)"]);
const KIND: Record<BonusAllocation["kind"], number> = { year_end_bonus: 0, bounty: 1, freelance: 2 };

export class PoolService {
  constructor(
    private readonly db: DB,
    private readonly org: OrgRepo,
    private readonly audit: AuditRepo,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly exclusive: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
  ) {}

  save(a: BonusAllocation, by: string) {
    this.db.prepare("INSERT OR REPLACE INTO bonus_allocations (allocation_id, json, created_by, settle_json, created_at) VALUES (?, ?, ?, NULL, ?)").run(a.allocation_id, JSON.stringify(a), by, a.created_at);
  }

  async settle(p: Persona, allocationId: string): Promise<BonusSettlement> {
    if (!isHr(p)) throw errors.forbidden("Only HR can settle a bonus pool");
    const row = this.db.prepare("SELECT json, settle_json FROM bonus_allocations WHERE allocation_id = ?").get(allocationId) as { json: string; settle_json: string | null } | undefined;
    if (!row) throw errors.notFound("Allocation not found");
    if (row.settle_json) return JSON.parse(row.settle_json);
    const c = this.config;
    if (!c.BONUS_POOL_ADDRESS || !c.PAYOUT_PRIVATE_KEY || !c.REVIEW_AGENT_PRIVATE_KEY || !c.RPC_URL) throw errors.invalidState("BonusPool is not configured (BONUS_POOL_ADDRESS, PAYOUT_PRIVATE_KEY, REVIEW_AGENT_PRIVATE_KEY)");
    const a = JSON.parse(row.json) as BonusAllocation;
    const div = BigInt(Math.max(1, Number(c.CHAIN_AMOUNT_DIVISOR ?? 1)));
    const lines = a.lines.map((l) => ({ ...l, onchain: BigInt(l.amount) / div })).filter((l) => l.onchain > 0n);
    if (!lines.length) throw errors.invalidState("Every line rounds to zero on chain");
    const budget = lines.reduce((x, l) => x + l.onchain, 0n);
    const cycle = this.org.cycle(a.cycle_id);
    const yearEnd = a.kind === "year_end_bonus";
    const periodEnd = yearEnd && cycle ? BigInt(Math.floor(Date.parse(`${cycle.ends_on}T23:59:59Z`) / 1000)) : 0n;
    const poolId = keccak256(stringToBytes(`proofwork:${a.allocation_id}`));

    const chain = defineChain({ id: c.CHAIN_ID, name: "arc-testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [c.RPC_URL] } } });
    const transport = fallback([...new Set([c.RPC_URL, "https://rpc.testnet.arc.network", "https://rpc.testnet.arc.io"])].map((u) => http(u, { retryCount: 4, retryDelay: 1500, timeout: 30_000 })));
    const pub = createPublicClient({ chain, transport });
    const hr = privateKeyToAccount(c.PAYOUT_PRIVATE_KEY as Hex);
    const agent = privateKeyToAccount(c.REVIEW_AGENT_PRIVATE_KEY as Hex);
    const pool = c.BONUS_POOL_ADDRESS as Hex;
    const base = c.EXPLORER_BASE_URL?.replace(/\/$/, "");
    const txs: BonusSettlement["txs"] = [];
    const send = async (step: string, by: string, account: typeof hr, req: any) => {
      const sim = await pub.simulateContract({ ...req, account }).catch((e: any) => {
        throw errors.conflict(`${step} was rejected by the contract: ${e?.shortMessage ?? String(e).split(String.fromCharCode(10))[0]}`);
      });
      const hash = await createWalletClient({ chain, account, transport }).writeContract(sim.request as any);
      await pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 2_000 });
      txs.push({ step, signed_by: by, tx_hash: hash, explorer_url: base ? `${base}/tx/${hash}` : null });
    };

    return this.exclusive(async () => {
      const allowance = (await pub.readContract({ address: USDC, abi: ERC20, functionName: "allowance", args: [hr.address, pool] })) as bigint;
      if (allowance < budget) await send("approve USDC", "HR payout key", hr, { address: USDC, abi: ERC20, functionName: "approve", args: [pool, budget * 100n] });
      await send("createPool", "HR payout key (POOL_ADMIN_ROLE)", hr, { address: pool, abi: ABI, functionName: "createPool", args: [poolId, KIND[a.kind], periodEnd, yearEnd ? 2000 : 0, yearEnd ? 7 * 86400 : 0, [a.bucket_id], [budget]] });
      const id = (await pub.readContract({ address: pool, abi: ABI, functionName: "nextAllocationId" })) as bigint;
      await send("proposeAllocation", "review-agent key (ALLOCATOR_ROLE)", agent, {
        address: pool, abi: ABI, functionName: "proposeAllocation",
        args: [poolId, a.bucket_id, lines.map((l) => l.wallet as Hex), lines.map((l) => l.onchain), lines.map((l) => l.evidence_hash as Hex), a.rationale_hash],
      });
      await send("approveAllocation", "HR payout key (APPROVER_ROLE)", hr, { address: pool, abi: ABI, functionName: "approveAllocation", args: [id] });
      if (!yearEnd) {
        for (let i = 0; i < lines.length; i++) await send(`release → ${lines[i].name}`, "HR payout key", hr, { address: pool, abi: ABI, functionName: "release", args: [id, BigInt(i)] });
      }
      const out: BonusSettlement = {
        allocation_id: a.allocation_id,
        pool_contract: pool,
        pool_id: poolId,
        onchain_allocation_id: Number(id),
        budget_onchain: budget.toString(),
        amount_divisor: Number(div),
        status: yearEnd ? "approved_locked_until_period_end" : "paid",
        unlocks_at: yearEnd && periodEnd ? iso(new Date(Number(periodEnd) * 1000)) : null,
        txs,
        settled_at: iso(this.clock.now()),
      };
      this.db.prepare("UPDATE bonus_allocations SET settle_json = ? WHERE allocation_id = ?").run(JSON.stringify(out), a.allocation_id);
      this.audit.append(out.settled_at, p.persona_id, "bonus_pool.settled", a.allocation_id, { pool_id: poolId, onchain_allocation_id: out.onchain_allocation_id, txs: txs.map((t) => t.tx_hash) });
      return out;
    });
  }
}
