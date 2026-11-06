// Record an Arc Studio deployment in deployments/arc.json (INTEGRATION section 7) after checking it on-chain.
// Read-only: sends no transactions.
//
//   node contracts/scripts/write-deployment.mjs --registry 0x... --vault 0x... [--asset 0x...] [--studio-url URL]
//
// Checks: chain id, code at both addresses, vault.asset() == asset, vault.registry() == registry, asset decimals == 6.
// Copies contracts/abi/{AttestationRegistry,BonusVault}.json to deployments/abi/ (spec:check verifies them).
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARC_TESTNET, ERC20, ROLE_HOLDERS, DEPLOYMENT_FILE, abi, args, clients, getAddress, root } from "./lib.mjs";

const a = args();
if (!a.registry || !a.vault) {
  console.error("usage: write-deployment.mjs --registry 0x... --vault 0x... [--asset 0x...] [--studio-url URL]");
  process.exit(2);
}
const registry = getAddress(a.registry);
const vault = getAddress(a.vault);
const asset = getAddress(a.asset ?? ARC_TESTNET.usdc);
const { pub } = clients();
const VAULT = abi("BonusVault");

let bad = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) bad++;
};

const chainId = await pub.getChainId();
check(chainId === ARC_TESTNET.chainId, `chain id ${chainId}`);
check(((await pub.getCode({ address: registry })) ?? "0x").length > 2, `registry has code ${registry}`);
check(((await pub.getCode({ address: vault })) ?? "0x").length > 2, `vault has code ${vault}`);
check(getAddress(await pub.readContract({ address: vault, abi: VAULT, functionName: "asset" })) === asset, `vault.asset() == ${asset}`);
check(getAddress(await pub.readContract({ address: vault, abi: VAULT, functionName: "registry" })) === registry, "vault.registry() == registry");
check(Number(await pub.readContract({ address: asset, abi: ERC20, functionName: "decimals" })) === 6, "asset decimals == 6");
if (bad) {
  console.error(`\n${bad} check(s) failed - deployments/arc.json NOT written`);
  process.exit(1);
}

mkdirSync(join(root, "deployments/abi"), { recursive: true });
for (const n of ["AttestationRegistry", "BonusVault"]) copyFileSync(join(root, `contracts/abi/${n}.json`), join(root, `deployments/abi/${n}.json`));

const out = {
  network: ARC_TESTNET.network,
  chainId: ARC_TESTNET.chainId,
  rpcUrl: ARC_TESTNET.rpcUrl,
  explorerBaseUrl: ARC_TESTNET.explorerBaseUrl,
  studioUrl: a["studio-url"] ?? "",
  registry,
  vault,
  asset,
  registryAbiFile: "deployments/abi/AttestationRegistry.json",
  vaultAbiFile: "deployments/abi/BonusVault.json",
  roleHolders: { anchor: getAddress(ROLE_HOLDERS.anchor), payout: getAddress(ROLE_HOLDERS.payout) },
  deployedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
};
writeFileSync(DEPLOYMENT_FILE, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote deployments/arc.json and deployments/abi/*`);
