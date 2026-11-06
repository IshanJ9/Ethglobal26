// ENS (Sepolia or mainnet) read-only resolution for the agent and the demo people.
// Names are only ever shown after a forward check: <label>.<ENS_PARENT_NAME> must resolve to exactly the wallet
// we hold for that person (or the agent's signing key). A name that resolves elsewhere, or not at all, is dropped.
// Nothing here sends a transaction; a failed lookup just means "no name".
import { createPublicClient, http, isAddressEqual, type Address, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import type { Config } from "../config.ts";

/** Agent text records Agent B publishes on the agent subname. */
export const AGENT_TEXT_KEYS = ["role", "spec", "policy", "url"] as const;

const DEFAULT_RPC = { sepolia: "https://ethereum-sepolia-rpc.publicnode.com", mainnet: "https://ethereum-rpc.publicnode.com" } as const;

/** "Asha Rao" -> "asha"; "Karan Shah (CFO, Acme Bank)" -> "karan". */
export const personaLabel = (displayName: string) => displayName.trim().split(/\s+/)[0].toLowerCase().normalize("NFKD").replace(/[^a-z0-9-]/g, "");

export interface AgentEns {
  name: string;
  resolved: Address | null;
  matches: boolean;
  text: Partial<Record<(typeof AGENT_TEXT_KEYS)[number], string>>;
}

export interface EnsLookup {
  address(name: string): Promise<Address | null>;
  text(name: string, key: string): Promise<string | null>;
}

export class EnsResolver implements EnsLookup {
  readonly rpcUrl: string;
  private readonly client: PublicClient;
  constructor(private readonly c: Pick<Config, "ENS_NETWORK" | "ENS_PARENT_NAME" | "ENS_RPC_URL">) {
    if (c.ENS_NETWORK === "none") throw new Error("ENS_NETWORK=none");
    this.rpcUrl = c.ENS_RPC_URL ?? DEFAULT_RPC[c.ENS_NETWORK];
    this.client = createPublicClient({ chain: c.ENS_NETWORK === "mainnet" ? mainnet : sepolia, transport: http(this.rpcUrl, { timeout: 10_000, retryCount: 1 }) }) as PublicClient;
  }

  async address(name: string): Promise<Address | null> {
    try {
      return (await this.client.getEnsAddress({ name: normalize(name) })) ?? null;
    } catch {
      return null;
    }
  }

  async text(name: string, key: string): Promise<string | null> {
    try {
      return (await this.client.getEnsText({ name: normalize(name), key })) ?? null;
    } catch {
      return null;
    }
  }

  agent(label: string, wallet: string | undefined) {
    return resolveAgent(this, fullName(label, this.c.ENS_PARENT_NAME), wallet);
  }
}

export const fullName = (label: string, parent: string | undefined) => (label.includes(".") || !parent ? label : `${label}.${parent}`);

export async function resolveAgent(r: EnsLookup, name: string, wallet: string | undefined): Promise<AgentEns> {
  const resolved = await r.address(name);
  const matches = !!(resolved && wallet && isAddressEqual(resolved, wallet as Address));
  const text: AgentEns["text"] = {};
  if (resolved) for (const k of AGENT_TEXT_KEYS) {
    const v = await r.text(name, k);
    if (v) text[k] = v;
  }
  return { name, resolved, matches, text };
}

/** Forward-checks <label>.<parent> for each person; returns wallet(lowercase) -> verified name. */
export async function resolvePeople(r: EnsLookup, parent: string, people: Array<{ display_name: string; wallet_address: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    people.map(async (p) => {
      const label = personaLabel(p.display_name);
      if (!label) return;
      const name = `${label}.${parent}`;
      const got = await r.address(name);
      if (got && isAddressEqual(got, p.wallet_address as Address)) out.set(p.wallet_address.toLowerCase(), name);
    }),
  );
  return out;
}
