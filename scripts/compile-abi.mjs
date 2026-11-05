// Compiles spec/solidity/*.sol with solcjs and writes spec/abi/<Name>.json (ABI array only). Deterministic.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const solc = require("solc");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["IAttestationRegistry", "IBonusVault"];
const sources = Object.fromEntries(names.map((n) => [`${n}.sol`, { content: readFileSync(join(root, `spec/solidity/${n}.sol`), "utf8") }]));
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity", sources,
  settings: { outputSelection: { "*": { "*": ["abi"] } } },
})));
const errs = (out.errors ?? []).filter((e) => e.severity === "error");
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
mkdirSync(join(root, "spec/abi"), { recursive: true });
for (const n of names) {
  const abi = out.contracts[`${n}.sol`][n].abi;
  writeFileSync(join(root, `spec/abi/${n}.json`), JSON.stringify(abi, null, 2) + "\n");
  console.log(n, "->", abi.length, "ABI entries");
}
