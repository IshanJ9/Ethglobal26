// ENS review credentials and agent self-publishing (ENSv2, Sepolia).
//
// When HR anchors a review on Arc, the backend ISSUER key registers r-<hash8>.<parent> as a subname token owned by the
// employee's wallet: expiring after one year, and with roleBitmap 0, so the employee can neither transfer nor delete it.
// Its records point at the review: review_hash, anchor_tx, anchor_chain, employee, issued_by. Only HR (UNREGISTER role
// on the registry) can revoke it. The issuer key has REGISTRAR + RENEW and SET_TEXT on the org resolver, nothing more.
// All of this is enforced by the ENS contracts (contracts/scripts/ens-roles.mjs), not by this code.
//
// The review agent signs its own `prompt` record (keccak of the system prompt it runs with) on its own resolver.
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, stringToBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { packetToBytes } from "viem/ens";
import { sepolia } from "viem/chains";
import type { Config } from "../config.ts";

const ABI = parseAbi([
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getTokenId(uint256 anyId) view returns (uint256)",
  "function setText(bytes name, string key, string value)",
  "function multicall(bytes[] calls) returns (bytes[])",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const YEAR = 365 * 86400;

export const credentialLabel = (reviewHash: string) => `r-${reviewHash.slice(2, 10).toLowerCase()}`;

export interface CredentialInput {
  reviewHash: Hex;
  anchorTx: string;
  chainId: number;
  owner: Hex;
  employeeEns: string | null;
  cluster: string;
}

export class EnsCredentials {
  private readonly pub;
  private readonly rpc: string;
  readonly enabled: boolean;

  constructor(private readonly c: Config, private readonly log: (m: string) => void) {
    this.rpc = c.ENS_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
    this.pub = createPublicClient({ chain: sepolia, transport: http(this.rpc, { timeout: 30_000, retryCount: 2 }) });
    this.enabled = c.ENS_NETWORK === "sepolia" && !!c.ENS_PARENT_NAME && !!c.ENS_ISSUER_PRIVATE_KEY && !!c.ENS_SUBREGISTRY && !!c.ENS_ORG_RESOLVER;
  }

  nameFor(reviewHash: string): string {
    return `${credentialLabel(reviewHash)}.${this.c.ENS_PARENT_NAME}`;
  }

  /** Register the credential (idempotent) and write its records in one multicall. Returns the name and tx hashes. */
  async issue(x: CredentialInput): Promise<{ name: string; register_tx: string | null; records_tx: string } | null> {
    if (!this.enabled) return null;
    const issuer = privateKeyToAccount(this.c.ENS_ISSUER_PRIVATE_KEY as Hex);
    const wallet = createWalletClient({ chain: sepolia, account: issuer, transport: http(this.rpc, { timeout: 30_000 }) });
    const label = credentialLabel(x.reviewHash);
    const name = `${label}.${this.c.ENS_PARENT_NAME}`;
    const sub = this.c.ENS_SUBREGISTRY as Hex;
    const res = this.c.ENS_ORG_RESOLVER as Hex;

    let registerTx: string | null = null;
    const tokenId = await this.pub.readContract({ address: sub, abi: ABI, functionName: "getTokenId", args: [BigInt(keccak256(stringToBytes(label)))] });
    const exists = await this.pub.readContract({ address: sub, abi: ABI, functionName: "ownerOf", args: [tokenId] }).then((o) => o !== ZERO, () => false);
    if (!exists) {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + YEAR);
      const sim = await this.pub.simulateContract({ account: issuer, address: sub, abi: ABI, functionName: "register", args: [label, x.owner, ZERO, res, 0n, expiry] });
      registerTx = await wallet.writeContract(sim.request);
      await this.pub.waitForTransactionReceipt({ hash: registerTx as Hex });
    }
    const dns = toHex(packetToBytes(name));
    const records: Record<string, string> = {
      role: "review-credential",
      review_hash: x.reviewHash,
      anchor_tx: x.anchorTx,
      anchor_chain: `arc-testnet:${x.chainId}`,
      employee: x.employeeEns ?? x.owner,
      cluster: x.cluster,
      issued_by: `issuer.${this.c.ENS_PARENT_NAME}`,
      description: "Proofwork performance review, anchored on Arc. Non-transferable; HR can revoke.",
    };
    const calls = Object.entries(records).map(([k, v]) => encodeFunctionData({ abi: ABI, functionName: "setText", args: [dns, k, v] }));
    const sim = await this.pub.simulateContract({ account: issuer, address: res, abi: ABI, functionName: "multicall", args: [calls] });
    const recordsTx = await wallet.writeContract(sim.request);
    await this.pub.waitForTransactionReceipt({ hash: recordsTx });
    this.log(`ENS review credential ${name} issued to ${x.owner} (register ${registerTx ?? "existing"}, records ${recordsTx})`);
    return { name, register_tx: registerTx, records_tx: recordsTx };
  }

  /** The review agent signs its own prompt record, if it differs from what is on chain. */
  async publishAgentPrompt(promptHash: Hex): Promise<string | null> {
    if (!(this.c.ENS_NETWORK === "sepolia" && this.c.REVIEW_AGENT_PRIVATE_KEY && this.c.ENS_REVIEW_AGENT_RESOLVER && this.c.ENS_PARENT_NAME)) return null;
    const name = `review-agent.${this.c.ENS_PARENT_NAME}`;
    const current = await this.pub.getEnsText({ name, key: "prompt" }).catch(() => null);
    if (current?.toLowerCase() === promptHash.toLowerCase()) {
      this.log(`ENS ${name} prompt record already matches the running prompt`);
      return null;
    }
    const agent = privateKeyToAccount(this.c.REVIEW_AGENT_PRIVATE_KEY as Hex);
    const wallet = createWalletClient({ chain: sepolia, account: agent, transport: http(this.rpc, { timeout: 30_000 }) });
    const sim = await this.pub.simulateContract({ account: agent, address: this.c.ENS_REVIEW_AGENT_RESOLVER as Hex, abi: ABI, functionName: "setText", args: [toHex(packetToBytes(name)), "prompt", promptHash] });
    const tx = await wallet.writeContract(sim.request);
    await this.pub.waitForTransactionReceipt({ hash: tx });
    this.log(`review agent ${agent.address} published its own prompt hash to ${name} (tx ${tx})`);
    return tx;
  }
}
