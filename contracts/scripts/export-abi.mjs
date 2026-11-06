// Copies the ABIs from `forge build` output into contracts/abi/ for `pnpm check:abi`.
// After deploying through Arc Studio, overwrite these with Studio's exported ABIs and re-run check:abi.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(dir, "abi"), { recursive: true });
for (const name of ["AttestationRegistry", "BonusVault", "MockUSDC"]) {
  const artifact = JSON.parse(readFileSync(join(dir, `out/${name}.sol/${name}.json`), "utf8"));
  writeFileSync(join(dir, `abi/${name}.json`), JSON.stringify(artifact.abi, null, 2) + "\n");
  console.log(`abi/${name}.json (${artifact.abi.length} entries)`);
}
