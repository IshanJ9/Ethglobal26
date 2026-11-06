// pnpm --filter @proofwork/api ens:probe - read-only: resolves the agent and every persona's ENS subname on
// ENS_NETWORK and prints which ones point at the expected wallet. Sends nothing.
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { seedOrg } from "../src/fixtures.ts";
import { EnsResolver, personaLabel } from "../src/ens/resolver.ts";
import { privateKeyToAccount } from "viem/accounts";

loadEnvFile();
const c = parseConfig({ ...process.env, ENS_NETWORK: process.env.ENS_NETWORK && process.env.ENS_NETWORK !== "none" ? process.env.ENS_NETWORK : "sepolia", ENS_PARENT_NAME: process.env.ENS_PARENT_NAME || "proofwork-demo.eth" });
const r = new EnsResolver(c);
const agentWallet = c.AGENT_ADDRESS ?? (c.ANCHOR_PRIVATE_KEY ? privateKeyToAccount(c.ANCHOR_PRIVATE_KEY as `0x${string}`).address : undefined);
console.log(`ENS ${c.ENS_NETWORK} parent ${c.ENS_PARENT_NAME} via ${r.rpcUrl}`);
const agent = await r.agent(c.AGENT_ENS_NAME, agentWallet);
console.log(`  agent ${agent.name} -> ${agent.resolved ?? "-"} ${agent.matches ? "ok (matches agent wallet)" : "NO MATCH"}`);
for (const [k, v] of Object.entries(agent.text)) console.log(`    text ${k} = ${v}`);
for (const p of seedOrg().personas) {
  const name = `${personaLabel(p.display_name)}.${c.ENS_PARENT_NAME}`;
  const got = await r.address(name);
  console.log(`  ${p.persona_id.padEnd(16)} ${name.padEnd(36)} ${got ? (got.toLowerCase() === p.wallet_address.toLowerCase() ? "ok" : `MISMATCH ${got}`) : "-"}`);
}
