// ENSv2 subnames as resolver records (docs.ens.domains/ensv2/subnames, "Subnames as Resolver Records").
// No subregistry and no Explorer "Create subname" step: the parent's Permissioned Resolver stores records for the
// full names, and the Universal Resolver reaches them through wildcard resolution (ENSIP-10).
//
//   node contracts/scripts/ens-records.mjs --parent proofwork-demo.eth [--agent-address 0x..] [--dry-run]
//
// Writes, in ONE multicall transaction on Sepolia from DEPLOYER_PRIVATE_KEY (which must hold the resolver's roles):
//   kra-agent.<parent>  ETH = agent address, text role / spec / policy / url / description
//   asha|ben|chen|elena|jon|acme-cfo.<parent>  ETH = seed persona wallet
// Idempotent: records already correct (read through the Universal Resolver) are skipped.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { args, createPublicClient, createWalletClient, formatEther, getAddress, http, loadEnv, privateKeyToAccount, root } from "./lib.mjs";

const req = createRequire(join(root, "apps/web/package.json"));
const { normalize, packetToBytes } = await import(pathToFileURL(req.resolve("viem/ens")).href);
const { sepolia } = await import(pathToFileURL(req.resolve("viem/chains")).href);
const { encodeFunctionData, toHex } = await import(pathToFileURL(req.resolve("viem")).href);

const a = args();
if (!a.parent) {
  console.error("usage: ens-records.mjs --parent <name>.eth [--agent-address 0x..] [--dry-run]");
  process.exit(2);
}
const dry = Boolean(a["dry-run"]);
const parent = normalize(String(a.parent));
loadEnv();
let pk = process.env.DEPLOYER_PRIVATE_KEY ?? "";
if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = "0x" + pk;
const owner = privateKeyToAccount(pk);
const rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: sepolia, account: owner, transport: http(rpc) });

const RESOLVER_ABI = [
  { type: "function", name: "setAddress", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "uint256" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "setText", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "string" }, { type: "string" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "nonpayable", inputs: [{ type: "bytes[]" }], outputs: [{ type: "bytes[]" }] },
];

// The parent's resolver. For an ENSv2 2LD it is stored in the v2 ETHRegistry (the legacy Universal Resolver only
// returns the ENSV2Resolver bridge 0x1cF3…, which cannot be written to); else fall back to the Universal Resolver.
const ETH_REGISTRY_V2 = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4"; // docs.ens.domains/learn/deployments (Sepolia)
const BRIDGE = "0x1cf3989ed3e5ec3cb1d731fc3777323813b61acf";
const label2 = parent.split(".").length === 2 && parent.endsWith(".eth") ? parent.split(".")[0] : null;
let resolver = label2
  ? await pub
      .readContract({ address: ETH_REGISTRY_V2, abi: [{ type: "function", name: "getResolver", stateMutability: "view", inputs: [{ type: "string" }], outputs: [{ type: "address" }] }], functionName: "getResolver", args: [label2] })
      .catch(() => null)
  : null;
if (!resolver || /^0x0+$/.test(resolver)) resolver = await pub.getEnsResolver({ name: parent });
if (!resolver || resolver.toLowerCase() === BRIDGE) throw new Error(`${parent}: could not find its writable resolver on Sepolia`);

const seed = JSON.parse(readFileSync(join(root, "spec/fixtures/seed-org.json"), "utf8"));
const SPEC_VERSION = readFileSync(join(root, "spec/VERSION"), "utf8").trim();
const plan = JSON.parse(readFileSync(join(root, "spec/fixtures/plans/pln_eng_v1.json"), "utf8"));
const wal = (pid) => getAddress(seed.personas.find((p) => p.persona_id === pid).wallet_address);
const agentAddress = getAddress(a["agent-address"] ?? "0x93a7931e4F6A1F124d438FA3fAB7E5d814A52A58"); // A's anchor key

const WANT = [
  {
    label: "kra-agent",
    addr: agentAddress,
    text: {
      role: "evidence-agent",
      spec: SPEC_VERSION,
      policy: a.policy ?? plan.formula_hash ?? "",
      url: "https://github.com/IshanJ9/Ethglobal26",
      description: "Proofwork evidence agent: collects from systems of record; never computes or approves.",
    },
  },
  ...[["asha", "p_dev_a"], ["ben", "p_dev_b"], ["chen", "p_dev_c"], ["elena", "p_eng_mgr"], ["jon", "p_hr"], ["acme-cfo", "p_client_cfo"]].map(
    ([label, pid]) => ({ label, addr: wal(pid), text: {} }),
  ),
];

console.log(`parent ${parent}, resolver ${resolver}, signer ${owner.address}${dry ? "  (dry run)" : ""}`);
console.log(`  gas balance ${formatEther(await pub.getBalance({ address: owner.address }))} ETH (Sepolia)`);

// ---- step 1: register subname tokens in the parent's subregistry (ENSv2 UserRegistry), if it has one ----
// The ENS Explorer "Create subname" button is disabled for v2 names right now; the registry contract itself is not.
// Requires ROLE_REGISTRAR on the subregistry (the wallet that deployed it via Explorer has it).
const REG_V2_ABI = [
  { type: "function", name: "getSubregistry", stateMutability: "view", inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getExpiry", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "hasRootRoles", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getResolver", stateMutability: "view", inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }], outputs: [{ type: "uint256" }] },
];
const ZERO = "0x0000000000000000000000000000000000000000";
const subregistry = label2 ? await pub.readContract({ address: ETH_REGISTRY_V2, abi: REG_V2_ABI, functionName: "getSubregistry", args: [label2] }).catch(() => ZERO) : ZERO;
const hasCode = subregistry !== ZERO && ((await pub.getCode({ address: subregistry })) ?? "0x").length > 2;
if (subregistry !== ZERO && !hasCode) throw new Error(`${parent}'s subregistry ${subregistry} is not a contract; reconfigure it in ENS Explorer (deploy a new Permissioned Registry)`);
if (hasCode) {
  const { keccak256, toHex: hx } = await import(pathToFileURL(req.resolve("viem")).href);
  const parentExpiry = await pub.readContract({ address: ETH_REGISTRY_V2, abi: REG_V2_ABI, functionName: "getExpiry", args: [BigInt(keccak256(hx(label2)))] });
  const canRegister = await pub.readContract({ address: subregistry, abi: REG_V2_ABI, functionName: "hasRootRoles", args: [1n, owner.address] });
  if (!canRegister) throw new Error(`${owner.address} lacks ROLE_REGISTRAR on subregistry ${subregistry}`);
  console.log(`  subregistry ${subregistry}, subnames expire with parent ${new Date(Number(parentExpiry) * 1000).toISOString().slice(0, 10)}`);
  for (const w of WANT) {
    const cur = await pub.readContract({ address: subregistry, abi: REG_V2_ABI, functionName: "getResolver", args: [w.label] }).catch(() => ZERO);
    if (cur !== ZERO) {
      console.log(`  ok   ${w.label}.${parent} registered`);
      continue;
    }
    // owner = signer, no child registry, the parent's resolver, no extra roles for the token (the registry admin keeps control).
    const s = await pub.simulateContract({ account: owner, address: subregistry, abi: REG_V2_ABI, functionName: "register", args: [w.label, owner.address, ZERO, resolver, 0n, parentExpiry] });
    if (dry) {
      console.log(`  todo register ${w.label}.${parent} (simulation ok)`);
      continue;
    }
    const h = await wallet.writeContract(s.request);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`register ${w.label} reverted (tx ${h})`);
    console.log(`  sent register ${w.label}.${parent}  tx ${h}`);
  }
}

// ---- step 2: records on the resolver, one multicall ----

const calls = [];
for (const w of WANT) {
  const full = `${w.label}.${parent}`;
  const dns = toHex(packetToBytes(full));
  const cur = await pub.getEnsAddress({ name: full }).catch(() => null);
  if (cur && getAddress(cur) === w.addr) console.log(`  ok   ${full} -> ${w.addr}`);
  else {
    console.log(`  set  ${full} -> ${w.addr}${cur ? `  (was ${cur})` : ""}`);
    calls.push(encodeFunctionData({ abi: RESOLVER_ABI, functionName: "setAddress", args: [dns, 60n, w.addr] }));
  }
  for (const [k, v] of Object.entries(w.text)) {
    if (!v) continue;
    const curT = await pub.getEnsText({ name: full, key: k }).catch(() => null);
    if (curT === v) console.log(`  ok   ${full} text ${k}`);
    else {
      console.log(`  set  ${full} text ${k}=${v}`);
      calls.push(encodeFunctionData({ abi: RESOLVER_ABI, functionName: "setText", args: [dns, k, v] }));
    }
  }
}

if (!calls.length) {
  console.log("\nnothing to do; all records already set");
  process.exit(0);
}
// Always simulate first: proves the signer holds the resolver roles before any gas is spent.
const sim = await pub.simulateContract({ account: owner, address: resolver, abi: RESOLVER_ABI, functionName: "multicall", args: [calls] });
console.log(`\nsimulation ok: ${calls.length} writes in one multicall`);
if (dry) {
  console.log("dry run: nothing sent. Re-run without --dry-run to send.");
  process.exit(0);
}
const hash = await wallet.writeContract(sim.request);
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== "success") throw new Error(`multicall reverted (tx ${hash})`);
console.log(`sent  tx ${hash}  https://sepolia.etherscan.io/tx/${hash}`);
console.log(`\nDONE. Check: node contracts/scripts/ens-check.mjs --parent ${parent}`);
console.log(`API env for A: ENS_NETWORK=sepolia ENS_PARENT_NAME=${parent} AGENT_ENS_NAME=kra-agent`);
