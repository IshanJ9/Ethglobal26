// Grant Agent A's role keys on the deployed contracts (idempotent: skips roles already held).
//
//   node contracts/scripts/grant-roles.mjs [--dry-run]
//
// Registry: ANCHOR_ROLE + ATTESTER_ROLE -> roleHolders.anchor
// Vault:    PLANNER_ROLE + PAYOUT_ROLE + DISPUTER_ROLE + RESOLVER_ROLE -> roleHolders.payout
// The DEPLOYER_PRIVATE_KEY wallet must hold DEFAULT_ADMIN_ROLE on both contracts (i.e. it self-deployed them).
import { abi, args, clients, getAddress, readDeployment, send } from "./lib.mjs";

const dry = Boolean(args()["dry-run"]);
const d = readDeployment();
const { pub, wallet, account } = clients(d, { needKey: true });
const ADMIN = "0x" + "00".repeat(32);

const plan = [
  { name: "registry", address: getAddress(d.registry), abi: abi("AttestationRegistry"), roles: ["ANCHOR_ROLE", "ATTESTER_ROLE"], to: getAddress(d.roleHolders.anchor) },
  { name: "vault", address: getAddress(d.vault), abi: abi("BonusVault"), roles: ["PLANNER_ROLE", "PAYOUT_ROLE", "DISPUTER_ROLE", "RESOLVER_ROLE"], to: getAddress(d.roleHolders.payout) },
];

console.log(`admin wallet ${account.address}${dry ? "  (dry run)" : ""}`);
let failed = 0;
for (const c of plan) {
  const read = (functionName, args = []) => pub.readContract({ address: c.address, abi: c.abi, functionName, args });
  if (!(await read("hasRole", [ADMIN, account.address]))) {
    console.error(`  FAIL ${c.name}: ${account.address} is not admin - redeploy from this wallet (Studio self-deploy)`);
    failed++;
    continue;
  }
  for (const role of c.roles) {
    const id = await read(role);
    if (await read("hasRole", [id, c.to])) {
      console.log(`  ok   ${c.name} ${role} already held by ${c.to}`);
      continue;
    }
    if (dry) {
      console.log(`  todo ${c.name} ${role} -> ${c.to}`);
      continue;
    }
    await send(pub, wallet, { address: c.address, abi: c.abi, functionName: "grantRole", args: [id, c.to] }, `${c.name} grantRole(${role}, ${c.to})`);
    if (!(await read("hasRole", [id, c.to]))) {
      console.error(`  FAIL ${c.name} ${role} not held after grant`);
      failed++;
    }
  }
}
console.log(failed ? `\nGRANT ROLES: ${failed} problem(s)` : "\nGRANT ROLES OK");
process.exit(failed ? 1 : 0);
