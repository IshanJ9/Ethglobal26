// Shared helpers for the operator scripts (deploy bookkeeping, roles, funding). These scripts send transactions
// from the deployer/admin wallet; app code never does (AGENT_B hard rule 5).
//
// The deployer key lives in contracts/.env (gitignored), e.g.
//   DEPLOYER_PRIVATE_KEY=0x...
// Keys are never printed.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEPLOYMENT_FILE = join(root, "deployments/arc.json");

// contracts/ is not a workspace package; borrow the pinned viem (2.21.0) from apps/web so versions match.
const req = createRequire(join(root, "apps/web/package.json"));
const viem = await import(pathToFileURL(req.resolve("viem")).href);
const accounts = await import(pathToFileURL(req.resolve("viem/accounts")).href);
export const { createPublicClient, createWalletClient, http, getAddress, parseUnits, formatUnits, parseEther, formatEther, defineChain } = viem;
export const { privateKeyToAccount } = accounts;

/** Arc Testnet, as confirmed from Arc Studio's chain registry (6 Nov 2026). */
export const ARC_TESTNET = {
  network: "arc-testnet",
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.io",
  explorerBaseUrl: "https://explorer.testnet.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
};

/** Agent A's role keys (public addresses only; private keys stay in apps/api/.env). */
export const ROLE_HOLDERS = {
  anchor: "0x93a7931e4F6A1F124d438FA3fAB7E5d814A52A58",
  payout: "0x0351C881633238E0E900755b50BB9258cDC9EF54",
};

export function loadEnv() {
  const p = join(root, "contracts/.env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function args() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const [k, v] = a[i].slice(2).split("=");
    out[k] = v ?? (a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true);
  }
  return out;
}

export function abi(name) {
  return JSON.parse(readFileSync(join(root, `contracts/abi/${name}.json`), "utf8"));
}

export const ERC20 = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

export function readDeployment() {
  if (!existsSync(DEPLOYMENT_FILE)) throw new Error("deployments/arc.json missing - run write-deployment.mjs first");
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
}

export function clients(d = ARC_TESTNET, { needKey = false } = {}) {
  const chain = defineChain({
    id: d.chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [d.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(d.rpcUrl) });
  if (!needKey) return { chain, pub };
  loadEnv();
  let pk = process.env.DEPLOYER_PRIVATE_KEY ?? "";
  if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = "0x" + pk; // MetaMask exports without 0x
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("DEPLOYER_PRIVATE_KEY missing or malformed in contracts/.env");
  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ chain, account, transport: http(d.rpcUrl) });
  return { chain, pub, wallet, account };
}

export async function send(pub, wallet, req, label) {
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted (tx ${hash})`);
  console.log(`  sent ${label}  tx ${hash}`);
  return r;
}
