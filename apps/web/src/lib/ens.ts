"use client";

import { useQuery } from "@tanstack/react-query";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { usePublicConfig } from "./config";

/**
 * ENS reads (AGENT_B 3.2). Read-only, via viem against the network the API reports in /v1/config/public `ens.network`.
 * Every read fails soft: no network, a bad name or a slow RPC just means "ENS not resolved", never a broken page.
 * NEXT_PUBLIC_ENS_RPC_URL overrides the default public RPC (recommended: the free public ones rate-limit).
 */
type Net = "sepolia" | "mainnet";
const clients: Partial<Record<Net, PublicClient>> = {};
// viem's built-in Sepolia default (rpc.sepolia.org) does not answer (checked 6 Nov 2026), so name our own defaults.
const DEFAULT_RPC: Record<Net, string> = {
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  mainnet: "https://ethereum-rpc.publicnode.com",
};

function client(net: Net): PublicClient {
  if (!clients[net]) {
    const chain = net === "sepolia" ? sepolia : mainnet;
    clients[net] = createPublicClient({ chain, transport: http(process.env.NEXT_PUBLIC_ENS_RPC_URL || DEFAULT_RPC[net], { timeout: 8000 }) }) as PublicClient;
  }
  return clients[net]!;
}

function useNet(): Net | null {
  const { data: cfg } = usePublicConfig();
  const n = cfg?.ens?.network;
  return n === "sepolia" || n === "mainnet" ? n : null;
}

const soft = async <T,>(f: () => Promise<T>): Promise<T | null> => {
  try {
    return await f();
  } catch {
    return null;
  }
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

/**
 * The name to show for an address: its primary name (reverse record) if set, else a candidate name
 * (from the API, or the demo label under the org's parent) that forward-resolves to this address. Never unverified.
 */
export function useVerifiedEnsName(address: string | undefined, candidate?: string | null) {
  const net = useNet();
  const { data: cfg } = usePublicConfig();
  const parent = cfg?.ens?.parent_name;
  const label = address ? DEMO_ENS_LABELS[address.toLowerCase()] : undefined;
  const guess = candidate ?? (label && parent ? `${label}.${parent}` : undefined);
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
