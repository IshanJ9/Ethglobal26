// Usage: node scripts/check-abi.mjs <exported-abi.json|artifact.json> <IAttestationRegistry|IBonusVault>
// Passes iff the candidate ABI is a SUPERSET of the frozen interface ABI (every function/event with identical types).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const sig = (e) => {
  const t = (xs = []) => xs.map((x) => (x.type.startsWith("tuple") ? `(${t(x.components)})${x.type.slice(5)}` : x.type)).join(",");
  return e.type === "function" ? `fn ${e.name}(${t(e.inputs)})->(${t(e.outputs)}) ${e.stateMutability}` : `${e.type} ${e.name}(${t(e.inputs)})`;
};
const norm = (s) => s.replace(/ (view|pure)$/, " read"); // view/pure are both read-only; accept either

export function checkAbi(candidate, iface) {
  const have = new Set(candidate.filter((e) => ["function", "event"].includes(e.type)).map((e) => norm(sig(e))));
  const missing = iface.filter((e) => ["function", "event"].includes(e.type)).map((e) => norm(sig(e))).filter((s) => !have.has(s));
  return missing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, name] = process.argv.slice(2);
  if (!file || !name) { console.error("usage: check-abi.mjs <abi.json> <IAttestationRegistry|IBonusVault>"); process.exit(2); }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const cand = Array.isArray(raw) ? raw : raw.abi;
  const iface = JSON.parse(readFileSync(join(root, `spec/abi/${name}.json`), "utf8"));
  const missing = checkAbi(cand, iface);
  if (missing.length) { console.error(`NOT CONFORMANT - ${missing.length} missing/mismatched:\n  ` + missing.join("\n  ")); process.exit(1); }
  console.log(`${name}: conformant (${iface.length} interface entries present)`);
}
