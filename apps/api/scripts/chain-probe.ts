// pnpm --filter @proofwork/api chain:probe - read-only check of the live chain config in apps/api/.env
// (run after Agent B writes deployments/arc.json): chain id, roles granted to our two keys, vault asset
// decimals and cycle balances. Sends no transactions; prints addresses only, never keys.
import { createPublicClient, getAddress, http, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { specJson } from "../src/fixtures.ts";

loadEnvFile();
const c = parseConfig({ ...process.env, CHAIN_MODE: "live" });
const pub = createPublicClient({ transport: http(c.RPC_URL!) });
const REG = specJson("abi/IAttestationRegistry.json") as Abi;
const VAULT = specJson("abi/IBonusVault.json") as Abi;
const ERC20 = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
const anchor = privateKeyToAccount(c.ANCHOR_PRIVATE_KEY as `0x${string}`).address;
const payout = privateKeyToAccount(c.PAYOUT_PRIVATE_KEY as `0x${string}`).address;
const read = (address: string, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address: getAddress(address), abi, functionName, args } as any) as Promise<any>;

let bad = 0;
const check = (ok: boolean, label: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) bad++;
};

const chainId = await pub.getChainId();
check(chainId === c.CHAIN_ID, `chain id ${chainId} (CHAIN_ID=${c.CHAIN_ID})`);
for (const [role, who, name] of [["ANCHOR_ROLE", anchor, "anchor"], ["ATTESTER_ROLE", anchor, "anchor"]] as const) {
  check(await read(c.REGISTRY_ADDRESS, REG, "hasRole", [await read(c.REGISTRY_ADDRESS, REG, role), who]), `registry ${role} -> ${name} ${who}`);
}
for (const role of ["PLANNER_ROLE", "PAYOUT_ROLE", "DISPUTER_ROLE", "RESOLVER_ROLE"]) {
  check(await read(c.VAULT_ADDRESS, VAULT, "hasRole", [await read(c.VAULT_ADDRESS, VAULT, role), payout]), `vault ${role} -> payout ${payout}`);
}
const asset = await read(c.VAULT_ADDRESS, VAULT, "asset");
check(getAddress(asset) === getAddress(c.ASSET_ADDRESS), `vault asset ${asset} (ASSET_ADDRESS=${c.ASSET_ADDRESS})`);
check(Number(await read(asset, ERC20 as unknown as Abi, "decimals")) === 6, "asset decimals == 6");
check(getAddress(await read(c.VAULT_ADDRESS, VAULT, "registry")) === getAddress(c.REGISTRY_ADDRESS), "vault.registry == REGISTRY_ADDRESS");
for (const cyc of [1n, 2n]) console.log(`  info cycleBalance(${cyc}) = ${(await read(c.VAULT_ADDRESS, VAULT, "cycleBalance", [cyc])).toString()} base units`);
for (const [n, a] of [["anchor", anchor], ["payout", payout]] as const) console.log(`  info ${n} ${a} gas balance = ${(await pub.getBalance({ address: a })).toString()}`);
console.log(bad ? `\nCHAIN PROBE: ${bad} problem(s)` : "\nCHAIN PROBE OK");
process.exit(bad ? 1 : 0);
