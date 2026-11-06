import type { FastifyInstance } from "fastify";
import { getAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { components } from "@proofwork/shared";
import { SPEC_VERSION, type Config } from "../config.ts";
import { seedOrg } from "../fixtures.ts";

type PublicConfig = components["schemas"]["PublicConfig"];

export function buildPublicConfig(c: Config): PublicConfig {
  const agentAddress =
    c.AGENT_ADDRESS ?? (c.ANCHOR_PRIVATE_KEY ? privateKeyToAccount(c.ANCHOR_PRIVATE_KEY as `0x${string}`).address : zeroAddress);
  return {
    spec_version: SPEC_VERSION,
    org_name: seedOrg().org.name,
    auth_mode: c.AUTH_MODE,
    chain_mode: c.CHAIN_MODE,
    chain: {
      chain_id: c.CHAIN_ID,
      name: c.CHAIN_MODE === "live" ? "Arc Testnet" : "Mock chain (in-process)",
      rpc_url: c.RPC_URL ?? null,
      explorer_base_url: c.EXPLORER_BASE_URL ?? null,
      ...(c.CHAIN_AMOUNT_DIVISOR > 1 ? { amount_divisor: c.CHAIN_AMOUNT_DIVISOR } : {}),
    },
    contracts: {
      registry: getAddress(c.REGISTRY_ADDRESS),
      vault: getAddress(c.VAULT_ADDRESS),
      asset: getAddress(c.ASSET_ADDRESS),
    },
    eip712_domain: {
      name: "Proofwork",
      version: "1",
      chainId: c.CHAIN_ID,
      verifyingContract: getAddress(c.REGISTRY_ADDRESS),
    },
    world_mode: c.WORLD_MODE,
    world_app_id: c.WORLD_APP_ID ?? null,
    zerog_mode: c.ZEROG_MODE,
    ens: { network: c.ENS_NETWORK, parent_name: c.ENS_PARENT_NAME ?? null },
    agent: { ens_name: c.AGENT_ENS_NAME, address: getAddress(agentAddress) },
  };
}

export async function metaRoutes(app: FastifyInstance, opts: { config: Config; agentName?: () => string }) {
  const base = buildPublicConfig(opts.config);
  // The agent ENS name upgrades to the full subname once the startup ENS check verifies it.
  const publicConfig = () => (opts.agentName ? { ...base, agent: { ...base.agent, ens_name: opts.agentName() } } : base);
  app.get("/healthz", async () => ({ ok: true, spec_version: SPEC_VERSION }));
  app.get("/v1/config/public", async () => publicConfig());
}
