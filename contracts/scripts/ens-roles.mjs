// ENSv2 role hierarchy with Enhanced Access Control (EAC). Enforced by the ENS contracts, not by the app.
//
//   node contracts/scripts/ens-roles.mjs [--dry-run]
//
// 1. One PermissionedResolver per department (VerifiableFactory proxy) holding the department, its clusters and
//    its people. Admin (org owner) has every role; HR has SET_TEXT + SET_ADDRESS (+ their admin roles, so HR can
//    delegate); the department manager gets SETTER roles for exactly the text keys `title`, `cluster`, `status`
//    (nothing else: no addresses, no other keys, no other department).
// 2. Each AI agent gets its OWN PermissionedResolver; the agent's own key holds the setter roles, so the agent
//    publishes its identity (e.g. review-agent's `prompt` hash) itself.
// 3. Role aliases via record linking: head.software -> elena, head.sales -> grace, head.marketing -> isha,
//    hrbp.people -> jon (reassign a role by relinking, no record copy).
// 4. Subname registry roles: HR may register/unregister people (hire/fire); the backend ISSUER key may only
//    register + renew (it issues expiring, non-transferable review credentials) and write text on the org resolver.
// 5. Names are re-pointed (setResolver) to their department / agent resolver.
// Writes deployments/ens-roles.json. Keys for the issuer and review-agent are created in apps/api/.env if missing.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { args, createPublicClient, createWalletClient, formatEther, getAddress, http, loadEnv, parseEther, privateKeyToAccount, root } from "./lib.mjs";

const req = createRequire(join(root, "apps/web/package.json"));
const v = await import(pathToFileURL(req.resolve("viem")).href);
const { packetToBytes, namehash } = await import(pathToFileURL(req.resolve("viem/ens")).href);
const { sepolia } = await import(pathToFileURL(req.resolve("viem/chains")).href);
const { generatePrivateKey } = await import(pathToFileURL(req.resolve("viem/accounts")).href);
const { encodeFunctionData, toHex, keccak256, stringToBytes, parseEventLogs } = v;

const a = args();
const dry = Boolean(a["dry-run"]);
loadEnv();
let pk = process.env.DEPLOYER_PRIVATE_KEY ?? "";
if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = "0x" + pk;
const owner = privateKeyToAccount(pk);
const rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: sepolia, account: owner, transport: http(rpc) });

// ---- protocol addresses (docs.ens.domains/learn/deployments, Sepolia ENSv2) ----
const FACTORY = "0xda70306c98e97ece36f997a21368e53298572991";
const RESOLVER_IMPL = "0x115eb53f0c60696633855f90b138178fb40b2b2c";

// ---- EAC role bits (PermissionedResolver / PermissionedRegistry) ----
const R = { SET_ADDRESS: 1n << 0n, SET_TEXT: 1n << 4n, SET_CONTENTHASH: 1n << 8n, SET_ABI: 1n << 12n, SET_INTERFACE: 1n << 16n, SET_NAME: 1n << 20n, SET_DATA: 1n << 24n, LINK: 1n << 28n, CAN_NAME: 1n << 120n, UPGRADE: 1n << 124n };
const adminOf = (r) => r << 128n;
const ALL = Object.values(R).reduce((x, r) => x | r | adminOf(r), 0n);
const REG = { REGISTRAR: 1n << 0n, UNREGISTER: 1n << 12n, RENEW: 1n << 16n, SET_RESOLVER: 1n << 24n };

const RES_ABI = v.parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
  "function linkToNode(bytes sourceName, bytes32 targetNode)",
  "function grantSetterRoles(bytes setter, address account)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function multicall(bytes[] calls) returns (bytes[])",
]);
const FACTORY_ABI = v.parseAbi(["function deployProxy(address implementation, uint256 salt, bytes data) returns (address)", "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)"]);
const SUB_ABI = v.parseAbi(["function setResolver(uint256 anyId, address resolver)", "function getResolver(string label) view returns (address)", "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)", "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)"]);

// ---- org data ----
const m = JSON.parse(readFileSync(join(root, "deployments/ens.json"), "utf8"));
const seed = JSON.parse(readFileSync(join(root, "spec/fixtures/seed-org.json"), "utf8"));
const parent = m.parent;
const wal = (pid) => getAddress(seed.personas.find((p) => p.persona_id === pid).wallet_address);
const ADMIN = owner.address;
const HR = wal("p_hr");
const MANAGERS = { software: wal("p_eng_mgr"), sales: wal("p_sales_mgr"), marketing: wal("p_mkt_mgr") };
const HEAD_ALIAS = { software: "elena", sales: "grace", marketing: "isha", people: "jon" };
const MANAGER_KEYS = ["title", "cluster", "status"];
const DEPTS = ["software", "sales", "marketing", "product", "people"];
const AGENTS = ["kra-agent", "review-agent"];
const fq = (l) => `${l}.${parent}`;
const dns = (n) => toHex(packetToBytes(n));

// ---- keys for the issuer (backend) and review-agent: generated once, stored in apps/api/.env ----
const apiEnv = join(root, "apps/api/.env");
const envText = existsSync(apiEnv) ? readFileSync(apiEnv, "utf8") : "";
const keyFromEnv = (k) => envText.match(new RegExp(`^${k}=(0x[0-9a-fA-F]{64})`, "m"))?.[1];
let issuerKey = keyFromEnv("ENS_ISSUER_PRIVATE_KEY");
let agentKey = keyFromEnv("REVIEW_AGENT_PRIVATE_KEY");
if (!dry && (!issuerKey || !agentKey)) {
  issuerKey ??= generatePrivateKey();
  agentKey ??= generatePrivateKey();
  appendFileSync(apiEnv, `\n# ---- ENS roles (contracts/scripts/ens-roles.mjs): testnet keys, Sepolia only ----\nENS_ISSUER_PRIVATE_KEY=${issuerKey}\nREVIEW_AGENT_PRIVATE_KEY=${agentKey}\n`);
  console.log("  created ENS_ISSUER_PRIVATE_KEY + REVIEW_AGENT_PRIVATE_KEY in apps/api/.env");
}
const ISSUER = issuerKey ? privateKeyToAccount(issuerKey).address : "0x000000000000000000000000000000000000dEaD";
const AGENT = agentKey ? privateKeyToAccount(agentKey).address : "0x000000000000000000000000000000000000bEEF";

// ---- which names go to which resolver ----
const kindOf = Object.fromEntries(m.names.map((n) => [n.name, n]));
const deptOfName = (n) => {
  if (n.kind === "department") return n.name.split(".")[0];
  if (n.kind === "cluster") return n.text.department?.split(".")[0];
  if (n.kind === "person" || n.kind === "client") return n.text.department?.split(".")[0] ?? "people";
  return null;
};
const recordCalls = (n) => {
  const d = dns(n.name);
  const c = [];
  if (n.addr) c.push(encodeFunctionData({ abi: RES_ABI, functionName: "setAddress", args: [d, 60n, n.addr] }));
  for (const [coin, addr] of Object.entries(n.coin ?? {})) c.push(encodeFunctionData({ abi: RES_ABI, functionName: "setAddress", args: [d, BigInt(coin), addr] }));
  for (const [k, val] of Object.entries(n.text)) c.push(encodeFunctionData({ abi: RES_ABI, functionName: "setText", args: [d, k, val] }));
  return c;
};

const out = existsSync(join(root, "deployments/ens-roles.json")) ? JSON.parse(readFileSync(join(root, "deployments/ens-roles.json"), "utf8")) : { resolvers: {} };
const send = async (label, request) => {
  if (dry) return console.log(`  todo ${label}`);
  const h = await wallet.writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`${label} reverted ${h}`);
  console.log(`  ${label}  tx ${h}`);
  return r;
};

console.log(`${parent}: admin ${ADMIN}, HR ${HR}, issuer ${ISSUER}, review-agent ${AGENT}${dry ? " (dry run)" : ""}`);
console.log(`  gas ${formatEther(await pub.getBalance({ address: owner.address }))} ETH`);

// 1 + 2 + 3: deploy resolvers with grants, records and aliases in the initializer
const groups = [
  ...DEPTS.map((d) => ({
    id: d,
    names: m.names.filter((n) => deptOfName(n) === d),
    grants: [{ account: ADMIN, roleBitmap: ALL }, { account: HR, roleBitmap: R.SET_TEXT | R.SET_ADDRESS | adminOf(R.SET_TEXT) | adminOf(R.SET_ADDRESS) }],
    alias: HEAD_ALIAS[d] ? [`${d === "people" ? "hrbp" : "head"}.${fq(d)}`, fq(HEAD_ALIAS[d])] : null,
  })),
  ...AGENTS.map((ag) => ({
    id: ag,
    names: m.names.filter((n) => n.name === fq(ag)),
    grants: [{ account: ADMIN, roleBitmap: ALL }, ...(ag === "review-agent" ? [{ account: AGENT, roleBitmap: R.SET_TEXT | R.SET_DATA }] : [])],
    alias: null,
  })),
];
for (const g of groups) {
  if (out.resolvers[g.id]) {
    console.log(`  ok   resolver ${g.id} ${out.resolvers[g.id]}`);
    continue;
  }
  const calls = g.names.flatMap(recordCalls);
  if (g.alias) calls.push(encodeFunctionData({ abi: RES_ABI, functionName: "linkToNode", args: [dns(g.alias[0]), namehash(g.alias[1])] }));
  const init = encodeFunctionData({ abi: RES_ABI, functionName: "initialize", args: [g.grants, calls] });
  const salt = BigInt(keccak256(stringToBytes(`proofwork:${parent}:${g.id}:v1`)));
  const s = await pub.simulateContract({ account: owner, address: FACTORY, abi: FACTORY_ABI, functionName: "deployProxy", args: [RESOLVER_IMPL, salt, init] });
  const r = await send(`deploy resolver ${g.id} (${g.names.length} names, ${calls.length} records)`, s.request);
  if (r) {
    const ev = parseEventLogs({ abi: FACTORY_ABI, logs: r.logs, eventName: "ProxyDeployed" })[0];
    out.resolvers[g.id] = ev.args.proxyAddress;
    writeFileSync(join(root, "deployments/ens-roles.json"), JSON.stringify(out, null, 2) + "\n");
  }
}

// alias resolution for the aliases above needs the *alias* name's lookup to reach the department resolver:
// head.software.<parent> sits under software.<parent> (wildcard), so it is served by the software resolver.

// managers: setter roles for exactly title / cluster / status on their department's resolver
for (const [d, mgr] of Object.entries(MANAGERS)) {
  const res = out.resolvers[d];
  if (!res && !dry) continue;
  const calls = MANAGER_KEYS.map((k) => encodeFunctionData({ abi: RES_ABI, functionName: "grantSetterRoles", args: [encodeFunctionData({ abi: RES_ABI, functionName: "setText", args: ["0x", k, ""] }), mgr] }));
  if (dry) {
    console.log(`  todo grant ${d} manager ${mgr} setter roles ${MANAGER_KEYS.join(",")}`);
    continue;
  }
  const s = await pub.simulateContract({ account: owner, address: res, abi: RES_ABI, functionName: "multicall", args: [calls] });
  await send(`grant ${d} manager setter roles (${MANAGER_KEYS.join(", ")})`, s.request);
}

// 4: registry roles + issuer on the org resolver
const subregistry = m.subregistry;
for (const [who, bits, label] of [[HR, REG.REGISTRAR | REG.UNREGISTER | REG.RENEW, "HR: register/unregister/renew people"], [ISSUER, REG.REGISTRAR | REG.RENEW, "issuer: register/renew review credentials"]]) {
  const has = await pub.readContract({ address: subregistry, abi: SUB_ABI, functionName: "hasRootRoles", args: [bits, who] }).catch(() => false);
  if (has) {
    console.log(`  ok   ${label}`);
    continue;
  }
  const s = await pub.simulateContract({ account: owner, address: subregistry, abi: SUB_ABI, functionName: "grantRootRoles", args: [bits, who] });
  await send(`registry role ${label}`, s.request);
}
{
  const has = await pub.readContract({ address: m.resolver, abi: RES_ABI, functionName: "hasRootRoles", args: [R.SET_TEXT, ISSUER] }).catch(() => false);
  if (!has) {
    const s = await pub.simulateContract({ account: owner, address: m.resolver, abi: RES_ABI, functionName: "grantRootRoles", args: [R.SET_TEXT | R.SET_ADDRESS, ISSUER] });
    await send("org resolver: issuer may write credential records", s.request);
  } else console.log("  ok   issuer on org resolver");
}

// 5: point names at their new resolver
for (const g of groups) {
  const res = out.resolvers[g.id];
  for (const n of g.names.filter((x) => x.kind !== "cluster")) {
    const label = n.name.slice(0, -(parent.length + 1));
    const cur = await pub.readContract({ address: subregistry, abi: SUB_ABI, functionName: "getResolver", args: [label] }).catch(() => null);
    if (res && cur && getAddress(cur) === getAddress(res)) continue;
    if (dry) {
      console.log(`  todo setResolver ${n.name} -> ${g.id} resolver`);
      continue;
    }
    const s = await pub.simulateContract({ account: owner, address: subregistry, abi: SUB_ABI, functionName: "setResolver", args: [BigInt(keccak256(stringToBytes(label))), res] });
    await send(`setResolver ${n.name} -> ${g.id}`, s.request);
  }
}

// gas for the actors that sign their own ENS writes (manager edits, HR, issuer, review-agent)
for (const [who, label] of [[HR, "HR"], ...Object.entries(MANAGERS).map(([d, x]) => [x, `${d} manager`]), [ISSUER, "issuer"], [AGENT, "review-agent"], [wal("p_dev_b"), "Ben (for the denied-edit demo)"]]) {
  const bal = await pub.getBalance({ address: who });
  if (bal >= parseEther("0.002")) continue;
  if (dry) {
    console.log(`  todo fund ${label} ${who}`);
    continue;
  }
  const h = await wallet.sendTransaction({ to: who, value: parseEther("0.005") });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  funded ${label} ${who} 0.005 ETH  tx ${h}`);
}

out.parent = parent;
out.roles = {
  admin: ADMIN,
  hr: HR,
  managers: MANAGERS,
  manager_keys: MANAGER_KEYS,
  issuer: ISSUER,
  review_agent: AGENT,
  aliases: Object.fromEntries(Object.entries(HEAD_ALIAS).map(([d, l]) => [`${d === "people" ? "hrbp" : "head"}.${fq(d)}`, fq(l)])),
  role_bits: { SET_ADDRESS: "1<<0", SET_TEXT: "1<<4", SET_DATA: "1<<24", LINK: "1<<28", admin: "role<<128" },
};
if (!dry) writeFileSync(join(root, "deployments/ens-roles.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`\n${dry ? "DRY RUN" : "DONE"}: deployments/ens-roles.json`);
