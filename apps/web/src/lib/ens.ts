"use client";

import { useQuery } from "@tanstack/react-query";
import { createPublicClient, fallback, getAddress, http, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { usePublicConfig } from "./config";
import ensManifest from "../../../../deployments/ens.json";

/**
 * ENS reads (AGENT_B 3.2). Read-only, via viem against the network the API reports in /v1/config/public `ens.network`.
 * Every read fails soft: no network, a bad name or a slow RPC just means "ENS not resolved", never a broken page.
 * NEXT_PUBLIC_ENS_RPC_URL overrides the default public RPC (recommended: the free public ones rate-limit).
 */
type Net = "sepolia" | "mainnet";
const clients: Partial<Record<Net, PublicClient>> = {};
// viem's built-in Sepolia default (rpc.sepolia.org) does not answer (checked 6 Nov 2026), so name our own defaults.
// Several public RPCs: each one rate-limits (429) a directory page that resolves ~48 names, so fall back across them.
const DEFAULT_RPC: Record<Net, string[]> = {
  sepolia: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co", "https://1rpc.io/sepolia"],
  mainnet: ["https://ethereum-rpc.publicnode.com"],
};

/** Sepolia transport with fallback + retries across public RPCs (reads and signed writes). */
export const sepoliaTransport = () =>
  fallback((process.env.NEXT_PUBLIC_ENS_RPC_URL ? [process.env.NEXT_PUBLIC_ENS_RPC_URL] : DEFAULT_RPC.sepolia).map((u) => http(u, { timeout: 20000, retryCount: 2, retryDelay: 800 })));

function client(net: Net): PublicClient {
  if (!clients[net]) {
    const chain = net === "sepolia" ? sepolia : mainnet;
    // multicall batching: a directory page resolves ~40 names x several records in a handful of RPC calls
    clients[net] = createPublicClient({ chain, batch: { multicall: true }, transport: fallback(
        (process.env.NEXT_PUBLIC_ENS_RPC_URL ? [process.env.NEXT_PUBLIC_ENS_RPC_URL] : DEFAULT_RPC[net]).map((u) => http(u, { timeout: 15000, retryCount: 2, retryDelay: 800 })),
      ) }) as PublicClient;
  }
  return clients[net]!;
}

function useNet(): Net | null {
  const { data: cfg } = usePublicConfig();
  const n = cfg?.ens?.network;
  return n === "sepolia" || n === "mainnet" ? n : null;
}

// Fails soft, but only after retrying: public RPCs drop calls under load (429), which is not "no record".
const soft = async <T,>(f: () => Promise<T>, attempts = 3): Promise<T | null> => {
  for (let i = 0; i < attempts; i++) {
    try {
      return await f();
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1) + Math.random() * 500));
    }
  }
  return null;
};

/** Reverse lookup: address -> primary ENS name (only if it forward-resolves back, which viem checks). */
export function useEnsName(address: string | undefined) {
  const net = useNet();
  return useQuery({
    queryKey: ["ens-name", net, address],
    queryFn: () => soft(() => client(net!).getEnsName({ address: getAddress(address!) })),
    enabled: !!net && !!address,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** Forward lookup: name -> address. */
export function useEnsAddress(name: string | undefined) {
  const net = useNet();
  return useQuery({
    queryKey: ["ens-addr", net, name],
    queryFn: () => soft(() => client(net!).getEnsAddress({ name: normalize(name!) })),
    enabled: !!net && !!name,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * Demo subname labels under ENS parent_name, keyed by wallet (seed personas). A label is only a CANDIDATE:
 * useVerifiedEnsName shows it only if the name resolves on chain to that exact address.
 */
export const DEMO_ENS_LABELS: Record<string, string> = {
  "0xe0a6b36d1381b1844a569acecde5501ca3aca9c1": "asha",
  "0xdd9bf67e531cc092d3695381b060b93cae557035": "ben",
  "0xc14372935dd977eace9b673c4d21fb466f9cc025": "chen",
  "0x533cd3d69794436c3bf8ef0f1eca50f3782dbbfa": "elena",
  "0x148e33e153c6c93bc91cac71d16487b93c52abd7": "jon",
  "0xdd0f57c26b23999240fd524ee43a4f918bba7415": "acme-cfo",
};

/** Candidate names from the org's ENS manifest (deployments/ens.json): people, clients, agents. Still forward-checked. */
const MANIFEST_NAME: Record<string, string> = Object.fromEntries(
  (ensManifest.names as unknown as Array<{ name: string; kind: string; addr?: string }>)
    .filter((n) => n.addr && ["person", "client", "agent"].includes(n.kind))
    .reverse() // first entry wins for a shared address (the agent over its signer key)
    .map((n) => [n.addr!.toLowerCase(), n.name]),
);

/**
 * The name to show for an address: its primary name (reverse record) if set, else a candidate name
 * (from the API, or the demo label under the org's parent) that forward-resolves to this address. Never unverified.
 */
export function useVerifiedEnsName(address: string | undefined, candidate?: string | null) {
  const net = useNet();
  const { data: cfg } = usePublicConfig();
  const parent = cfg?.ens?.parent_name;
  const label = address ? DEMO_ENS_LABELS[address.toLowerCase()] : undefined;
  const guess = candidate ?? (address ? MANIFEST_NAME[address.toLowerCase()] : undefined) ?? (label && parent ? `${label}.${parent}` : undefined);
  return useQuery({
    queryKey: ["ens-verified", net, address, guess],
    queryFn: async () => {
      const c = client(net!);
      const primary = await soft(() => c.getEnsName({ address: getAddress(address!) }));
      if (primary) return primary;
      if (!guess) return null;
      const resolved = await soft(() => c.getEnsAddress({ name: normalize(guess) }));
      return resolved && getAddress(resolved) === getAddress(address!) ? guess : null;
    },
    enabled: !!net && !!address,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** Text record, e.g. role / spec / policy / url on the agent's name. */
export function useEnsText(name: string | undefined, key: string) {
  const net = useNet();
  return useQuery({
    queryKey: ["ens-text", net, name, key],
    queryFn: () => soft(() => client(net!).getEnsText({ name: normalize(name!), key })),
    enabled: !!net && !!name,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * Everything the directory shows for one name, resolved live: ETH address, optional multichain address
 * (ENSIP-11 coin type, e.g. Arc testnet) and the given text records. Values are what ENS returns now,
 * never what the manifest claims; the page compares the two.
 */
export function useEnsRecords(name: string | undefined, keys: string[], coinType?: number) {
  const net = useNet();
  return useQuery({
    queryKey: ["ens-records", net, name, keys.join(","), coinType],
    queryFn: async () => {
      const c = client(net!);
      const n = normalize(name!);
      const [addr, coinAddr, ...texts] = await Promise.all([
        soft(() => c.getEnsAddress({ name: n })),
        coinType ? soft(() => c.getEnsAddress({ name: n, coinType })) : Promise.resolve(null),
        ...keys.map((key) => soft(() => c.getEnsText({ name: n, key }))),
      ]);
      return { addr, coinAddr, text: Object.fromEntries(keys.map((k, i) => [k, texts[i]])) as Record<string, string | null> };
    },
    enabled: !!net && !!name,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
