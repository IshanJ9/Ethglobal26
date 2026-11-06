// Fund the vault's demo cycles from the admin wallet, and optionally top up Agent A's keys with gas.
//
//   node contracts/scripts/fund.mjs --amount 50 [--cycles 1,2] [--gas-each 2] [--dry-run]
//
// --amount    USDC per cycle (decimal string, 6-decimal ERC-20 at deployments/arc.json `asset`)
// --gas-each  native USDC (Arc gas token) to send to each of roleHolders.anchor/payout
// Approves exactly what is needed, then calls fundCycle(cycle, amount) for each cycle.
// Release needs cycleBalance >= entitlement (target * multiplier), so fund at least what the demo releases.
import { ERC20, abi, args, clients, formatEther, formatUnits, getAddress, parseEther, parseUnits, readDeployment, send } from "./lib.mjs";

const a = args();
if (!a.amount && !a["gas-each"]) {
  console.error("usage: fund.mjs --amount <usdc per cycle> [--cycles 1,2] [--gas-each <usdc>] [--dry-run]");
  process.exit(2);
}
const dry = Boolean(a["dry-run"]);
const d = readDeployment();
const { pub, wallet, account } = clients(d, { needKey: true });
const vault = getAddress(d.vault);
const asset = getAddress(d.asset);
const VAULT = abi("BonusVault");
const cycles = String(a.cycles ?? "1,2").split(",").map((c) => BigInt(c.trim()));

console.log(`admin wallet ${account.address}${dry ? "  (dry run)" : ""}`);
console.log(`  gas balance  ${formatEther(await pub.getBalance({ address: account.address }))} USDC (native)`);
const bal = await pub.readContract({ address: asset, abi: ERC20, functionName: "balanceOf", args: [account.address] });
console.log(`  token balance ${formatUnits(bal, 6)} USDC (ERC-20)`);

if (a["gas-each"]) {
  const v = parseEther(String(a["gas-each"]));
  for (const [name, to] of Object.entries(d.roleHolders)) {
    const addr = getAddress(to);
    console.log(`  ${name} ${addr} gas balance ${formatEther(await pub.getBalance({ address: addr }))}`);
    if (dry) { console.log(`  todo send ${a["gas-each"]} USDC gas -> ${name}`); continue; }
    const hash = await wallet.sendTransaction({ to: addr, value: v });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`gas transfer to ${name} failed (tx ${hash})`);
    console.log(`  sent ${a["gas-each"]} USDC gas -> ${name}  tx ${hash}`);
  }
}

if (a.amount) {
  const per = parseUnits(String(a.amount), 6);
  const total = per * BigInt(cycles.length);
  if (bal < total) {
    console.error(`\nFAIL need ${formatUnits(total, 6)} USDC for ${cycles.length} cycle(s), wallet has ${formatUnits(bal, 6)}`);
    process.exit(1);
  }
  const allowance = await pub.readContract({ address: asset, abi: ERC20, functionName: "allowance", args: [account.address, vault] });
  if (allowance < total) {
    if (dry) console.log(`  todo approve(vault, ${formatUnits(total, 6)})`);
    else await send(pub, wallet, { address: asset, abi: ERC20, functionName: "approve", args: [vault, total] }, `approve(vault, ${formatUnits(total, 6)})`);
  }
  for (const c of cycles) {
    if (dry) { console.log(`  todo fundCycle(${c}, ${a.amount})`); continue; }
    await send(pub, wallet, { address: vault, abi: VAULT, functionName: "fundCycle", args: [c, per] }, `fundCycle(${c}, ${a.amount} USDC)`);
  }
  for (const c of cycles) {
    const cb = await pub.readContract({ address: vault, abi: VAULT, functionName: "cycleBalance", args: [c] });
    console.log(`  cycleBalance(${c}) = ${formatUnits(cb, 6)} USDC`);
  }
}
console.log("\nFUND DONE");
