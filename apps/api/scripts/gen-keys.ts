// Creates apps/api/.env from the repo-root .env.example with fresh random secrets and the two
// role keypairs (anchor, payout). Prints ONLY the public addresses. Never overwrites a value that is
// already set. Testnet use only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API_DIR, REPO_ROOT } from "../src/config.ts";

const envPath = join(API_DIR, ".env");
let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
const hex32 = () => "0x" + randomBytes(32).toString("hex");

const fresh: Record<string, () => string> = {
  JWT_SECRET: () => randomBytes(32).toString("base64url"),
  ORG_SECRET: hex32,
  DATA_KEY: hex32,
  CONNECTOR_KEY: () => randomBytes(24).toString("base64url"),
  ANCHOR_PRIVATE_KEY: generatePrivateKey,
  PAYOUT_PRIVATE_KEY: generatePrivateKey,
};
// Placeholder values from .env.example count as "unset".
const placeholder = /^(|change-me.*|demo-connector-key-change-me|0x0{63}[12])$/;

const changed: string[] = [];
for (const [name, gen] of Object.entries(fresh)) {
  const re = new RegExp(`^${name}=([^\\s#]*)(.*)$`, "m");
  const m = text.match(re);
  if (m && !placeholder.test(m[1])) continue;
  const line = `${name}=${gen()}`;
  text = m ? text.replace(re, `${line}$2`) : `${text.trimEnd()}\n${line}\n`;
  changed.push(name);
}
writeFileSync(envPath, text, { mode: 0o600 });

const key = (n: string) => text.match(new RegExp(`^${n}=(0x[0-9a-fA-F]{64})`, "m"))?.[1] as `0x${string}`;
console.log(changed.length ? `Wrote ${changed.join(", ")} to apps/api/.env` : "apps/api/.env already complete; nothing changed");
console.log("Role addresses for Agent B (grant roles in the deploy script):");
console.log("  anchor (ANCHOR_ROLE + ATTESTER_ROLE):", privateKeyToAccount(key("ANCHOR_PRIVATE_KEY")).address);
console.log("  payout (PAYOUT/PLANNER/DISPUTER/RESOLVER):", privateKeyToAccount(key("PAYOUT_PRIVATE_KEY")).address);
