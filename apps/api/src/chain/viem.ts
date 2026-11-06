// Live ChainClient against the deployed Arc contracts using the frozen interface ABIs (spec/abi).
// Two role keys: ANCHOR (anchor + attest + revoke), PAYOUT (planner/payout/disputer/resolver).
// Waits for receipts, parses ScoreAttested for the id, retries nonce errors once, maps reverts to ChainRevert.
import type { Hex } from "@proofwork/crypto";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseEventLogs,
  type Abi,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Config } from "../config.ts";
import { specJson } from "../fixtures.ts";
import { ChainRevert, type AttestArgs, type Attestation, type ChainClient, type PayoutState, type RegisterArgs } from "./types.ts";

const REGISTRY_ABI = specJson("abi/IAttestationRegistry.json") as Abi;
const VAULT_ABI = specJson("abi/IBonusVault.json") as Abi;

function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r) return r.reason ?? r.data?.errorName ?? r.shortMessage;
    return e.shortMessage;
  }
  return (e as Error)?.message ?? String(e);
}
const isNonceError = (e: unknown) => /nonce/i.test(revertReason(e));

export class ViemChain implements ChainClient {
  readonly mode = "live" as const;
  private readonly pub: PublicClient;
  private readonly anchor: { wallet: WalletClient; account: PrivateKeyAccount };
  private readonly payout: { wallet: WalletClient; account: PrivateKeyAccount };
  private readonly registry: Address;
  private readonly vault: Address;

  constructor(c: Config) {
    if (!c.RPC_URL || !c.ANCHOR_PRIVATE_KEY || !c.PAYOUT_PRIVATE_KEY) throw new Error("CHAIN_MODE=live needs RPC_URL, ANCHOR_PRIVATE_KEY, PAYOUT_PRIVATE_KEY");
    const chain = defineChain({
      id: c.CHAIN_ID,
      name: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [c.RPC_URL] } },
    });
    const transport = http(c.RPC_URL, { retryCount: 2, timeout: 30_000 });
    this.pub = createPublicClient({ chain, transport }) as PublicClient;
    const mk = (pk: string) => {
      const account = privateKeyToAccount(pk as Hex);
      return { account, wallet: createWalletClient({ chain, transport, account }) };
    };
    this.anchor = mk(c.ANCHOR_PRIVATE_KEY);
    this.payout = mk(c.PAYOUT_PRIVATE_KEY);
    this.registry = getAddress(c.REGISTRY_ADDRESS);
    this.vault = getAddress(c.VAULT_ADDRESS);
  }

  private async write(
    who: "anchor" | "payout",
    target: "registry" | "vault",
    functionName: string,
    args: readonly unknown[],
  ): Promise<{ txHash: Hex; logs: any[] }> {
    const { wallet, account } = who === "anchor" ? this.anchor : this.payout;
    const address = target === "registry" ? this.registry : this.vault;
    const abi = target === "registry" ? REGISTRY_ABI : VAULT_ABI;
    const attempt = async () => {
      const { request } = await this.pub.simulateContract({ address, abi, functionName, args, account } as any);
      const hash = await wallet.writeContract(request as any);
      const rcpt = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rcpt.status !== "success") throw new ChainRevert("transaction reverted", functionName);
      return { txHash: hash as Hex, logs: rcpt.logs };
    };
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof ChainRevert) throw e;
      if (isNonceError(e)) {
        try {
          return await attempt();
        } catch (e2) {
          throw new ChainRevert(revertReason(e2), functionName);
        }
      }
      throw new ChainRevert(revertReason(e), functionName);
    }
  }

  private async read<T>(target: "registry" | "vault", functionName: string, args: readonly unknown[]): Promise<T> {
    try {
      return (await this.pub.readContract({
        address: target === "registry" ? this.registry : this.vault,
        abi: target === "registry" ? REGISTRY_ABI : VAULT_ABI,
        functionName,
        args,
      } as any)) as T;
    } catch (e) {
      throw new ChainRevert(revertReason(e), functionName);
    }
  }

  async now() {
    return (await this.pub.getBlock({ blockTag: "latest" })).timestamp;
  }

  anchorBatch(root: Hex, batchId: bigint, count: number) {
    return this.write("anchor", "registry", "anchorBatch", [root, batchId, count]);
  }

  async attestScore(a: AttestArgs) {
    const r = await this.write("anchor", "registry", "attestScore", [
      a.subjectId,
      a.cycleId,
      a.version,
      a.scoreCommitment,
      a.evidenceRoot,
      a.formulaHash,
      a.approvalProofHash,
      a.multiplierBps,
      a.supersedes,
    ]);
    const ev = parseEventLogs({ abi: REGISTRY_ABI, logs: r.logs, eventName: "ScoreAttested" }) as any[];
    if (!ev.length) throw new ChainRevert("ScoreAttested event not found in receipt", "attestScore");
    return { txHash: r.txHash, attestationId: BigInt(ev[0].args.attestationId) };
  }

  revoke(id: bigint, reasonHash: Hex) {
    return this.write("anchor", "registry", "revoke", [id, reasonHash]);
  }
  registerPlan(a: RegisterArgs) {
    return this.write("payout", "vault", "registerPlan", [a.subjectId, a.cycleId, a.payee, a.targetBonus, a.holdbackBps, a.maturitySeconds]);
  }
  release(attId: bigint) {
    return this.write("payout", "vault", "release", [attId]);
  }
  releaseHoldback(attId: bigint) {
    return this.write("payout", "vault", "releaseHoldback", [attId]);
  }
  dispute(attId: bigint, reasonHash: Hex) {
    return this.write("payout", "vault", "dispute", [attId, reasonHash]);
  }
  resolveDispute(attId: bigint, release: boolean) {
    return this.write("payout", "vault", "resolveDispute", [attId, release]);
  }
  applyRevision(oldId: bigint, newId: bigint) {
    return this.write("payout", "vault", "applyRevision", [oldId, newId]);
  }

  async getAttestation(id: bigint): Promise<Attestation> {
    const a = await this.read<any>("registry", "getAttestation", [id]);
    return {
      subjectId: a.subjectId,
      cycleId: BigInt(a.cycleId),
      version: Number(a.version),
      scoreCommitment: a.scoreCommitment,
      evidenceRoot: a.evidenceRoot,
      formulaHash: a.formulaHash,
      approvalProofHash: a.approvalProofHash,
      multiplierBps: Number(a.multiplierBps),
      supersedes: BigInt(a.supersedes),
      attestedAt: BigInt(a.attestedAt),
      revoked: Boolean(a.revoked),
    };
  }

  async getPayout(subjectId: Hex, cycleId: bigint): Promise<PayoutState> {
    const p = await this.read<any>("vault", "getPayout", [subjectId, cycleId]);
    return {
      payee: p.payee,
      targetBonus: BigInt(p.targetBonus),
      holdbackBps: Number(p.holdbackBps),
      maturityAt: BigInt(p.maturityAt),
      attestationId: BigInt(p.attestationId),
      entitlement: BigInt(p.entitlement),
      paid: BigInt(p.paid),
      held: BigInt(p.held),
      forfeited: BigInt(p.forfeited),
      overpaid: BigInt(p.overpaid),
      status: Number(p.status),
    };
  }

  batchRoot(batchId: bigint) {
    return this.read<Hex>("registry", "batchRoot", [batchId]);
  }
  async latestAttestation(subjectId: Hex, cycleId: bigint) {
    return BigInt(await this.read<bigint>("registry", "latestAttestation", [subjectId, cycleId]));
  }
}
