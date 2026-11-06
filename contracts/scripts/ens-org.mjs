// ENS as the organisation's directory (ENSv2 on Sepolia). Run with tsx (it reads the 0G reviewer's system
// prompt from apps/api so the review-agent's `prompt` record is the real hash):
//
//   npx tsx contracts/scripts/ens-org.mjs --parent proofwork-demo.eth [--dry-run] [--records-only]
//
//   proofwork-demo.eth                      org root: name, url, departments, clusters
//   software|sales|marketing|product|people  departments (subname tokens): head, clusters
//   ic.software, senior.software, ae.sales,  clusters (records on the org resolver, ENSv2 wildcard):
//   exec.marketing, pm.product                 plan id + policy (= plan formula_hash) + KRAs + members
//   kra-agent, review-agent                  agents: role, model, prompt hash, policy
//   anchor, payout                           chain signer keys with their contract roles
//   registry, vault                          Arc contracts as ENSIP-11 multichain addresses (coin type 0x80000000|5042002)
//   asha, ben, ... (30 people)               ETH address + dept, cluster, title, manager
//
// Writes deployments/ens.json (the manifest the web reads, then checks every entry live against ENS).
// Idempotent: labels already registered and records already correct are skipped.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { args, createPublicClient, createWalletClient, formatEther, getAddress, http, loadEnv, privateKeyToAccount, root } from "./lib.mjs";
import { SYSTEM_PROMPT } from "../../apps/api/src/review/reasoning.ts";

const req = createRequire(join(root, "apps/web/package.json"));
const { normalize, packetToBytes, namehash } = await import(pathToFileURL(req.resolve("viem/ens")).href);
const { sepolia } = await import(pathToFileURL(req.resolve("viem/chains")).href);
const { encodeFunctionData, toHex, keccak256, stringToBytes } = await import(pathToFileURL(req.resolve("viem")).href);

const a = args();
const parent = normalize(String(a.parent ?? "proofwork-demo.eth"));
const dry = Boolean(a["dry-run"]);
const recordsOnly = Boolean(a["records-only"]);
loadEnv();
let pk = process.env.DEPLOYER_PRIVATE_KEY ?? "";
if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = "0x" + pk;
const owner = privateKeyToAccount(pk);
const rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: sepolia, account: owner, transport: http(rpc) });

const ETH_REGISTRY_V2 = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4";
const ZERO = "0x0000000000000000000000000000000000000000";
const REG = [
  { type: "function", name: "getSubregistry", stateMutability: "view", inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getResolver", stateMutability: "view", inputs: [{ type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getExpiry", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint64" }], outputs: [{ type: "uint256" }] },
];
const RES = [
  { type: "function", name: "setAddress", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "uint256" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "setText", stateMutability: "nonpayable", inputs: [{ type: "bytes" }, { type: "string" }, { type: "string" }], outputs: [] },
  { type: "function", name: "multicall", stateMutability: "nonpayable", inputs: [{ type: "bytes[]" }], outputs: [{ type: "bytes[]" }] },
];

// ---------------------------------------------------------------- the organisation
const seed = JSON.parse(readFileSync(join(root, "spec/fixtures/seed-org.json"), "utf8"));
const clusters = JSON.parse(readFileSync(join(root, "spec/fixtures/clusters.json"), "utf8")).clusters;
const deploy = JSON.parse(readFileSync(join(root, "deployments/arc.json"), "utf8"));
const plan = (id) => JSON.parse(readFileSync(join(root, `spec/fixtures/plans/${id}.json`), "utf8"));
const ARC_COIN = (0x80000000 | deploy.chainId) >>> 0; // ENSIP-11 EVM coin type for Arc testnet
const label = (displayName) => (displayName.startsWith("Karan") ? "acme-cfo" : displayName.split(" ")[0].toLowerCase());
const CLUSTER_LABEL = { "software.ic": "ic.software", "software.senior_ic": "senior.software", "sales.ic": "ae.sales", "marketing.ic": "exec.marketing", "product.ic": "pm.product" };
const DEPTS = [
  ["software", "Software Engineering"],
  ["sales", "Sales"],
  ["marketing", "Marketing"],
  ["product", "Product"],
  ["people", "People team (HR)"],
];
const TITLE = { "software.ic": "Software Engineer", "software.senior_ic": "Senior Software Engineer", "sales.ic": "Account Executive", "marketing.ic": "Marketing Executive", "product.ic": "Product Manager" };
const emps = seed.employees;
const personas = seed.personas;
const byId = Object.fromEntries(emps.map((e) => [e.employee_id, e]));
const fq = (l) => `${l}.${parent}`;

const names = [];
const add = (n) => names.push(n);
add({
  name: parent, kind: "org", register: false,
  text: {
    description: `${seed.org.name}: every bonus is earned from committed evidence, decided by verified humans and proven on chain.`,
    url: "https://github.com/IshanJ9/Ethglobal26",
    "org.name": seed.org.name,
    "org.departments": DEPTS.map(([d]) => fq(d)).join(","),
    "org.clusters": Object.values(CLUSTER_LABEL).map(fq).join(","),
    "org.agents": [fq("kra-agent"), fq("review-agent")].join(","),
  },
});
for (const [d, title] of DEPTS) {
  const head = emps.find((e) => e.department === d && e.level === "manager") ?? (d === "people" ? { display_name: "Jon Ruiz" } : null);
  add({
    name: fq(d), kind: "department", register: true,
    text: {
      description: `${title} department of ${seed.org.name}.`,
      role: "department",
      ...(head ? { head: fq(label(head.display_name)) } : {}),
      ...(clusters.some((c) => c.department === d) ? { clusters: clusters.filter((c) => c.department === d).map((c) => fq(CLUSTER_LABEL[c.cluster_id])).join(",") } : {}),
    },
  });
}
for (const c of clusters) {
  const p = plan(c.plan_id);
  const members = emps.filter((e) => e.department === c.department && e.level === c.level);
  add({
    name: fq(CLUSTER_LABEL[c.cluster_id]), kind: "cluster", register: false, // record-only: resolved through the department's resolver (ENSv2 wildcard)
    text: {
      description: c.description,
      role: "cluster",
      cluster: c.cluster_id,
      department: fq(c.department),
      plan: c.plan_id,
      policy: p.formula_hash,
      kras: (p.kras.length ? p.kras.map((k) => `${k.kra_id}:${k.weight_bps}`) : ["commission:tiered"]).join(","),
      members: members.map((e) => fq(label(e.display_name))).join(","),
    },
  });
}
add({
  name: fq("kra-agent"), kind: "agent", register: true, addr: deploy.roleHolders.anchor,
  text: { role: "evidence-agent", description: "Proofwork evidence agent: collects from systems of record (git, tickets, CRM, HRIS); never computes or approves.", spec: readFileSync(join(root, "spec/VERSION"), "utf8").trim(), policy: plan("pln_eng_v1").formula_hash, url: "https://github.com/IshanJ9/Ethglobal26" },
});
add({
  name: fq("review-agent"), kind: "agent", register: true,
  text: {
    role: "review-agent",
    description: "Writes bonus-review reasoning inside 0G Private Computer from the encrypted evidence vault. Every number it writes is checked against the data packet.",
    model: process.env.ZEROG_MODEL || "0gm-1.0-35b-a3b",
    provider: "0G Private Computer (TeeML)",
    prompt: keccak256(stringToBytes(SYSTEM_PROMPT)),
    rules: "numbers-from-packet-only; same-cluster-only; one-retry-then-labelled-fallback",
  },
});
add({ name: fq("anchor"), kind: "signer", register: true, addr: deploy.roleHolders.anchor, text: { role: "chain-signer", roles: "ANCHOR_ROLE,ATTESTER_ROLE", contract: fq("registry") } });
add({ name: fq("payout"), kind: "signer", register: true, addr: deploy.roleHolders.payout, text: { role: "chain-signer", roles: "PLANNER_ROLE,PAYOUT_ROLE,DISPUTER_ROLE,RESOLVER_ROLE", contract: fq("vault") } });
add({ name: fq("registry"), kind: "contract", register: true, coin: { [ARC_COIN]: deploy.registry }, text: { role: "contract", contract: "AttestationRegistry", chain: `${deploy.network}:${deploy.chainId}`, explorer: `${deploy.explorerBaseUrl}/address/${deploy.registry}` } });
add({ name: fq("vault"), kind: "contract", register: true, coin: { [ARC_COIN]: deploy.vault }, text: { role: "contract", contract: "BonusVault", chain: `${deploy.network}:${deploy.chainId}`, asset: "USDC", explorer: `${deploy.explorerBaseUrl}/address/${deploy.vault}` } });

const PEOPLE = [...emps.map((e) => ({ display_name: e.display_name, wallet: e.wallet_address, e })), ...personas.filter((p) => !byId[p.employee_id]).map((p) => ({ display_name: p.display_name, wallet: p.wallet_address, p }))];
for (const x of PEOPLE) {
  const e = x.e;
  const cid = e ? `${e.department}.${e.level}` : null;
  const cl = cid && CLUSTER_LABEL[cid] ? fq(CLUSTER_LABEL[cid]) : null;
  const mgr = e?.manager_employee_id ? byId[e.manager_employee_id] : null;
  const dept = e ? e.department : x.p.role === "hr" ? "people" : null;
  const title = e ? (e.level === "manager" ? `${e.department[0].toUpperCase() + e.department.slice(1)} manager` : TITLE[cid] ?? e.level) : x.p.role === "hr" ? "HR business partner" : "CFO, Acme Bank (client)";
  add({
    name: fq(label(x.display_name)), kind: x.p?.role === "external_cosigner" ? "client" : "person", register: true, addr: getAddress(x.wallet),
    text: {
      name: x.display_name,
      title,
      ...(dept ? { department: fq(dept) } : { org: "Acme Bank" }),
      ...(cl ? { cluster: cl } : {}),
      ...(mgr ? { manager: fq(label(mgr.display_name)) } : {}),
    },
  });
}

// ---------------------------------------------------------------- chain state
const label2 = parent.split(".")[0];
const resolver = await pub.readContract({ address: ETH_REGISTRY_V2, abi: REG, functionName: "getResolver", args: [label2] });
const subregistry = await pub.readContract({ address: ETH_REGISTRY_V2, abi: REG, functionName: "getSubregistry", args: [label2] });
const expiry = await pub.readContract({ address: ETH_REGISTRY_V2, abi: REG, functionName: "getExpiry", args: [BigInt(keccak256(toHex(label2)))] });
if (resolver === ZERO || subregistry === ZERO) throw new Error(`${parent} needs a resolver and a subregistry (deploy it once in ENS Explorer)`);
console.log(`${parent}: resolver ${resolver}, subregistry ${subregistry}, signer ${owner.address}${dry ? " (dry run)" : ""}`);
console.log(`  gas ${formatEther(await pub.getBalance({ address: owner.address }))} ETH, ${names.length} names`);

// 1. register subname tokens (one tx each, skipped when present)
if (!recordsOnly) {
  for (const n of names.filter((x) => x.register)) {
    const l = n.name.slice(0, -(parent.length + 1));
    const cur = await pub.readContract({ address: subregistry, abi: REG, functionName: "getResolver", args: [l] }).catch(() => ZERO);
    if (cur !== ZERO) continue;
    const s = await pub.simulateContract({ account: owner, address: subregistry, abi: REG, functionName: "register", args: [l, owner.address, ZERO, resolver, 0n, expiry] });
    if (dry) {
      console.log(`  todo register ${n.name}`);
      continue;
    }
    const h = await wallet.writeContract(s.request);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`register ${l} reverted ${h}`);
    console.log(`  registered ${n.name}  tx ${h}`);
  }
}

// 2. records (only the ones that differ), batched in multicalls
const calls = [];
for (const n of names) {
  const dns = toHex(packetToBytes(n.name));
  if (n.addr) {
    const cur = await pub.getEnsAddress({ name: n.name }).catch(() => null);
    if (!cur || getAddress(cur) !== getAddress(n.addr)) calls.push(encodeFunctionData({ abi: RES, functionName: "setAddress", args: [dns, 60n, n.addr] }));
  }
  for (const [coin, addr] of Object.entries(n.coin ?? {})) {
    const cur = await pub.getEnsAddress({ name: n.name, coinType: Number(coin) }).catch(() => null);
    if (!cur || getAddress(cur) !== getAddress(addr)) calls.push(encodeFunctionData({ abi: RES, functionName: "setAddress", args: [dns, BigInt(coin), addr] }));
  }
  for (const [k, v] of Object.entries(n.text)) {
    const cur = await pub.getEnsText({ name: n.name, key: k }).catch(() => null);
    if (cur !== v) calls.push(encodeFunctionData({ abi: RES, functionName: "setText", args: [dns, k, v] }));
  }
}
console.log(`  ${calls.length} record writes needed`);
for (let i = 0; i < calls.length; i += 40) {
  const chunk = calls.slice(i, i + 40);
  const s = await pub.simulateContract({ account: owner, address: resolver, abi: RES, functionName: "multicall", args: [chunk] });
  if (dry) {
    console.log(`  todo multicall of ${chunk.length} (simulation ok)`);
    continue;
  }
  const h = await wallet.writeContract(s.request);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`multicall reverted ${h}`);
  console.log(`  records ${i + 1}-${i + chunk.length}  tx ${h}`);
}

// 3. manifest for the web (what to look up); the web verifies every value live against ENS
const manifest = {
  network: "sepolia",
  parent,
  resolver,
  subregistry,
  arc_coin_type: ARC_COIN,
  generated_at: new Date().toISOString(),
  names: names.map((n) => ({ name: n.name, kind: n.kind, ...(n.addr ? { addr: getAddress(n.addr) } : {}), ...(n.coin ? { coin: n.coin } : {}), text: n.text })),
};
if (!dry) writeFileSync(join(root, "deployments/ens.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n${dry ? "DRY RUN" : "DONE"}: manifest ${dry ? "not written" : "deployments/ens.json"}; check with: node contracts/scripts/ens-check.mjs --parent ${parent}`);
