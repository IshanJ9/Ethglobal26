// Read-only: check that the demo ENS names resolve on Sepolia to the right addresses and the agent's text records
// are set. Works for both legacy and ENSv2 names (uses the universal resolver).
//
//   node contracts/scripts/ens-check.mjs --parent proofwork-demo.eth [--agent-address 0x..]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { args, createPublicClient, getAddress, http, root } from "./lib.mjs";

const req = createRequire(join(root, "apps/web/package.json"));
const { sepolia } = await import(pathToFileURL(req.resolve("viem/chains")).href);
const a = args();
if (!a.parent) {
  console.error("usage: ens-check.mjs --parent <name>.eth");
  process.exit(2);
}
const parent = String(a.parent);
const pub = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com") });
const seed = JSON.parse(readFileSync(join(root, "spec/fixtures/seed-org.json"), "utf8"));
const wallet = (pid) => getAddress(seed.personas.find((p) => p.persona_id === pid).wallet_address);
const agent = getAddress(a["agent-address"] ?? "0x93a7931e4F6A1F124d438FA3fAB7E5d814A52A58");

// --single: no subnames (the ENS app cannot create them for ENSv2 names yet); the parent itself is the agent/org name.
const single = Boolean(a.single);
const agentName = single ? parent : `kra-agent.${parent}`;
const want = single
  ? [[parent, a["agent-address"] ? agent : null]]
  : [
      [agentName, agent],
      ...[["asha", "p_dev_a"], ["ben", "p_dev_b"], ["chen", "p_dev_c"], ["elena", "p_eng_mgr"], ["jon", "p_hr"], ["acme-cfo", "p_client_cfo"]].map(
        ([l, pid]) => [`${l}.${parent}`, wallet(pid)],
      ),
    ];
let bad = 0;
for (const [name, addr] of want) {
  const got = await pub.getEnsAddress({ name }).catch(() => null);
  const ok = !!got && (addr === null || getAddress(got) === addr);
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "MISS"} ${name} -> ${got ?? "(none)"}${ok || addr === null ? "" : `  want ${addr}`}`);
}
for (const key of ["role", "spec", "policy", "url"]) {
  const v = await pub.getEnsText({ name: agentName, key }).catch(() => null);
  if (!v) bad++;
  console.log(`  ${v ? "ok  " : "MISS"} ${agentName} text ${key} = ${v ?? "(none)"}`);
}
console.log(bad ? `\nENS CHECK: ${bad} missing` : "\nENS CHECK OK");
process.exit(bad ? 1 : 0);
