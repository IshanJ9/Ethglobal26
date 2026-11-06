// Read-only: check every name, address (ETH + ENSIP-11) and text record in deployments/ens.json against
// Sepolia ENS through the Universal Resolver.  node contracts/scripts/ens-verify-org.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, getAddress, http, root } from "./lib.mjs";

const req = createRequire(join(root, "apps/web/package.json"));
const { sepolia } = await import(pathToFileURL(req.resolve("viem/chains")).href);
const pub = createPublicClient({ chain: sepolia, batch: { multicall: true }, transport: http(process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com") });
const m = JSON.parse(readFileSync(join(root, "deployments/ens.json"), "utf8"));

let bad = 0;
let checked = 0;
const byKind = {};
for (const n of m.names) {
  const errs = [];
  if (n.addr) {
    const got = await pub.getEnsAddress({ name: n.name }).catch(() => null);
    checked++;
    if (!got || getAddress(got) !== getAddress(n.addr)) errs.push(`addr ${got ?? "none"}`);
  }
  for (const [coin, addr] of Object.entries(n.coin ?? {})) {
    const got = await pub.getEnsAddress({ name: n.name, coinType: Number(coin) }).catch(() => null);
    checked++;
    if (!got || getAddress(got) !== getAddress(addr)) errs.push(`coin ${coin} ${got ?? "none"}`);
  }
  for (const [k, v] of Object.entries(n.text)) {
    const got = await pub.getEnsText({ name: n.name, key: k }).catch(() => null);
    checked++;
    if (got !== v) errs.push(`text ${k}`);
  }
  byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  if (errs.length) {
    bad++;
    console.log(`  MISS ${n.name}: ${errs.join("; ")}`);
  }
}
console.log(`${m.names.length} names (${Object.entries(byKind).map(([k, v]) => `${v} ${k}`).join(", ")}), ${checked} values checked`);
console.log(bad ? `ENS ORG CHECK: ${bad} names not matching` : "ENS ORG CHECK OK");
process.exit(bad ? 1 : 0);
