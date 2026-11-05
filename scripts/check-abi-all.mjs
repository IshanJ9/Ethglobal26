// pnpm check:abi - Agent B puts the Arc Studio ABI exports in contracts/abi/{AttestationRegistry,BonusVault}.json (raw ABI array or artifact with .abi).
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let bad = false;
for (const [file, iface] of [["AttestationRegistry", "IAttestationRegistry"], ["BonusVault", "IBonusVault"]]) {
  const p = join(root, `contracts/abi/${file}.json`);
  if (!existsSync(p)) { console.error(`MISSING contracts/abi/${file}.json - export the ABI from Arc Studio`); bad = true; continue; }
  try { execFileSync("node", [join(root, "scripts/check-abi.mjs"), p, iface], { stdio: "inherit" }); } catch { bad = true; }
}
process.exit(bad ? 1 : 0);
