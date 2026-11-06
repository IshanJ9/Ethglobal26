// pnpm --filter @proofwork/api seed:reset - wipes the local DB and replica dir, re-runs migrations,
// loads spec/fixtures (org, plans, cycles). Demo evidence is then played with POST /v1/dev/inject.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { API_DIR, loadEnvFile, parseConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { loadOrgFixtures } from "../src/db/org.ts";

loadEnvFile();
const config = parseConfig();
if (config.NODE_ENV === "production") {
  console.error("Refusing to reset a production database.");
  process.exit(1);
}
if (config.dbPath !== ":memory:") {
  try {
    for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) if (existsSync(f)) rmSync(f);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM") {
      console.error(`Cannot delete ${config.dbPath}: it is in use. Stop the API (pnpm dev) first, then run seed:reset again.`);
      process.exit(1);
    }
    throw e;
  }
}
const replica = join(API_DIR, "data", "replica");
if (existsSync(replica)) rmSync(replica, { recursive: true });

const db = openDb(config.dbPath);
loadOrgFixtures(db);
const count = (t: string) => db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get();
console.log(`Reset ${config.dbPath}`);
console.log(`  personas=${count("org_personas")} employees=${count("org_employees")} cycles=${count("org_cycles")} plans=${count("org_plans")}`);
db.close();
