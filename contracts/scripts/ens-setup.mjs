// ENS setup on Sepolia (AGENT_B 3.2): subnames for the evidence agent and the demo people, with real records.
//
//   node contracts/scripts/ens-setup.mjs --parent proofwork-demo.eth [--agent-address 0x..] [--dry-run] [--no-reverse]
//
// For each subname: create it under the parent (owner = the DEPLOYER_PRIVATE_KEY wallet, which must own the parent),
// point it at the parent's resolver, set its address record. The agent name also gets text records
// role / spec / policy / url. Unless --no-reverse, each demo wallet also gets a primary name (reverse record) so the
// app can show "asha.<parent>" next to her address; the demo key signs that, after the deployer sends it a little gas.
//
// Everything is derived on chain from the ENS registry: whether the parent is wrapped (NameWrapper) or not, which
// resolver it uses, and the reverse registrar. Idempotent: records that are already right are skipped.
// Env (contracts/.env): DEPLOYER_PRIVATE_KEY, optional SEPOLIA_RPC_URL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { args, createPublicClient, createWalletClient, formatEther, getAddress, http, loadEnv, parseEther, privateKeyToAccount, root } from "./lib.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const req = createRequire(join(root, "apps/web/package.json"));
const { namehash, labelhash, normalize } = await import(pathToFileURL(req.resolve("viem/ens")).href);
const { sepolia } = await import(pathToFileURL(req.resolve("viem/chains")).href);
const { keccak256, stringToBytes, zeroAddress } = await import(pathToFileURL(req.resolve("viem")).href);

const a = args();
if (!a.parent) {
  console.error("usage: ens-setup.mjs --parent <name>.eth [--agent-address 0x..] [--dry-run] [--no-reverse]");
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

const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e"; // same address on every ENS network
const REG_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "resolver", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "setSubnodeRecord", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint64" }], outputs: [] },
];
const WRAPPER_ABI = [
  { type: "function", name: "getData", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }, { type: "uint32" }, { type: "uint64" }] },
  { type: "function", name: "setSubnodeRecord", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "string" }, { type: "address" }, { type: "address" }, { type: "uint64" }, { type: "uint32" }, { type: "uint64" }], outputs: [{ type: "bytes32" }] },
];
const RESOLVER_ABI = [
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "setAddr", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [] },
  { type: "function", name: "text", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [{ type: "string" }] },
  { type: "function", name: "setText", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "string" }, { type: "string" }], outputs: [] },
];
const REVERSE_ABI = [{ type: "function", name: "setName", stateMutability: "nonpayable", inputs: [{ type: "string" }], outputs: [{ type: "bytes32" }] }];

const read = (address, abi, functionName, args) => pub.readContract({ address, abi, functionName, args });
async function write(label, req, from = wallet) {
  if (dry) return console.log(`  todo ${label}`);
  const hash = await from.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
  console.log(`  sent ${label}  tx ${hash}`);
}

// ---- who gets a name ----
const seed = JSON.parse(readFileSync(join(root, "spec/fixtures/seed-org.json"), "utf8"));
const SPEC_VERSION = readFileSync(join(root, "spec/VERSION"), "utf8").trim();
const PEOPLE = [
  ["asha", "p_dev_a"], ["ben", "p_dev_b"], ["chen", "p_dev_c"], ["elena", "p_eng_mgr"], ["jon", "p_hr"], ["acme-cfo", "p_client_cfo"],
];
const persona = (id) => seed.personas.find((p) => p.persona_id === id);
const agentAddress = getAddress(a["agent-address"] ?? "0x93a7931e4F6A1F124d438FA3fAB7E5d814A52A58"); // A's anchor key unless told otherwise
const plan = JSON.parse(readFileSync(join(root, "spec/fixtures/plans/pln_eng_v1.json"), "utf8"));
const policy = a.policy ?? plan.formula_hash ?? "";

// ---- parent ----
const parentNode = namehash(parent);
const regOwner = await read(REGISTRY, REG_ABI, "owner", [parentNode]);
const resolver = await read(REGISTRY, REG_ABI, "resolver", [parentNode]);
if (regOwner === zeroAddress) {
  // Names registered through the current ENS app live in the newer registry (ENSv2): the universal resolver finds
  // them, the legacy registry does not. Subnames there are created in the ENS app; print exactly what to create.
  const viaUR = await pub.getEnsAddress({ name: parent }).catch(() => null);
  if (!viaUR) throw new Error(`${parent} is not registered on Sepolia`);
  console.log(`${parent} resolves to ${viaUR} via the universal resolver but is not in the legacy registry (ENSv2 name).`);
  console.log(`Use instead: node contracts/scripts/ens-records.mjs --parent ${parent}  (registers subnames + records on v2).`);
  console.log(`Its subregistry must first be deployed once in ENS Explorer (Registry -> Deploy a new Permissioned Registry).`);
  console.log(`Create these in https://sepolia.app.ens.domains/${parent} -> Subnames, then set each one's ETH address record:\n`);
  console.log(`  kra-agent.${parent}  ETH ${agentAddress}`);
  console.log(`    text records: role=evidence-agent  spec=${SPEC_VERSION}  policy=${policy}  url=https://github.com/IshanJ9/Ethglobal26`);
  for (const [label, pid] of PEOPLE) console.log(`  ${label}.${parent}  ETH ${getAddress(persona(pid).wallet_address)}`);
  console.log(`\nAPI env for A: ENS_NETWORK=sepolia ENS_PARENT_NAME=${parent} AGENT_ENS_NAME=kra-agent`);
  console.log(`Check afterwards: node contracts/scripts/ens-check.mjs --parent ${parent}`);
  process.exit(0);
}
if (resolver === zeroAddress) throw new Error(`${parent} has no resolver; set one in the ENS app first`);
let wrapped = false;
let parentExpiry = 0n;
try {
  const [wOwner, , expiry] = await read(regOwner, WRAPPER_ABI, "getData", [BigInt(parentNode)]);
  if (wOwner !== zeroAddress) {
    wrapped = true;
    parentExpiry = expiry;
    if (getAddress(wOwner) !== owner.address) throw new Error(`${parent} is owned by ${wOwner} in the NameWrapper, not ${owner.address}`);
  }
} catch (e) {
  if (String(e.message).includes("owned by")) throw e;
}
if (!wrapped && getAddress(regOwner) !== owner.address) throw new Error(`${parent} is owned by ${regOwner}, not ${owner.address}`);

console.log(`parent ${parent} (${wrapped ? "wrapped" : "unwrapped"}), resolver ${resolver}, owner ${owner.address}${dry ? "  (dry run)" : ""}`);
console.log(`  gas balance ${formatEther(await pub.getBalance({ address: owner.address }))} ETH (Sepolia)`);

async function ensureSubname(label) {
  const full = `${label}.${parent}`;
  const node = namehash(full);
  const exists = (await read(REGISTRY, REG_ABI, "owner", [node])) !== zeroAddress;
  if (exists) return { full, node, created: false };
  if (wrapped) {
    await write(`create ${full}`, { address: regOwner, abi: WRAPPER_ABI, functionName: "setSubnodeRecord", args: [parentNode, label, owner.address, resolver, 0n, 0, parentExpiry] });
  } else {
    await write(`create ${full}`, { address: REGISTRY, abi: REG_ABI, functionName: "setSubnodeRecord", args: [parentNode, labelhash(label), owner.address, resolver, 0n] });
  }
  return { full, node, created: true };
}

async function ensureAddr(full, node, addr) {
  const cur = dry ? zeroAddress : await read(resolver, RESOLVER_ABI, "addr", [node]).catch(() => zeroAddress);
  if (cur !== zeroAddress && getAddress(cur) === getAddress(addr)) return console.log(`  ok   ${full} -> ${addr}`);
  await write(`addr ${full} -> ${addr}`, { address: resolver, abi: RESOLVER_ABI, functionName: "setAddr", args: [node, addr] });
}

async function ensureText(full, node, key, value) {
  const cur = dry ? "" : await read(resolver, RESOLVER_ABI, "text", [node, key]).catch(() => "");
  if (cur === value) return console.log(`  ok   ${full} text ${key}`);
  await write(`text ${full} ${key}=${value}`, { address: resolver, abi: RESOLVER_ABI, functionName: "setText", args: [node, key, value] });
}

// ---- agent ----
const agent = await ensureSubname("kra-agent");
await ensureAddr(agent.full, agent.node, agentAddress);
for (const [k, v] of [["role", "evidence-agent"], ["spec", SPEC_VERSION], ["policy", policy], ["url", "https://github.com/IshanJ9/Ethglobal26"], ["description", "Proofwork evidence agent: collects from systems of record; never computes or approves."]]) {
  if (v) await ensureText(agent.full, agent.node, k, v);
}

// ---- people ----
const reverseRegistrar = await read(REGISTRY, REG_ABI, "owner", [namehash("addr.reverse")]);
for (const [label, pid] of PEOPLE) {
  const p = persona(pid);
  const s = await ensureSubname(label);
  await ensureAddr(s.full, s.node, getAddress(p.wallet_address));
  if (a["no-reverse"]) continue;
  // Primary name: signed by the demo key (DEMO ONLY, never holds real value) after a small gas top-up.
  const demo = privateKeyToAccount(keccak256(stringToBytes(`proofwork-demo-persona:${pid}`)));
  const current = await pub.getEnsName({ address: demo.address }).catch(() => null);
  if (current === s.full) {
    console.log(`  ok   primary name ${demo.address} = ${s.full}`);
    continue;
  }
  const bal = await pub.getBalance({ address: demo.address });
  if (bal < parseEther("0.0005")) {
    if (dry) console.log(`  todo send 0.001 ETH gas -> ${label} ${demo.address}`);
    else {
      const hash = await wallet.sendTransaction({ to: demo.address, value: parseEther("0.001") });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`  sent 0.001 ETH gas -> ${label}  tx ${hash}`);
    }
  }
  const demoWallet = createWalletClient({ chain: sepolia, account: demo, transport: http(rpc) });
  await write(`primary name ${demo.address} = ${s.full}`, { address: reverseRegistrar, abi: REVERSE_ABI, functionName: "setName", args: [s.full] }, demoWallet);
}

console.log(`\nENS SETUP ${dry ? "DRY RUN " : ""}DONE. API env for A: ENS_NETWORK=sepolia ENS_PARENT_NAME=${parent} AGENT_ENS_NAME=kra-agent`);
