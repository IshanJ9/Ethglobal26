// pnpm --filter @proofwork/api exec tsx scripts/replicate-0g.ts [--cluster software.ic | --all] [--cycle cyc_2026h2] [--limit N]
// CR-004: moves the ENCRYPTED evidence payloads of existing items from the local replica to 0G Storage
// (items ingested while 0G storage was not configured). The payload is the same sealed ciphertext the
// ledger stores (record-key encrypted); 0G never sees plaintext. After upload the evidence row points at
// the 0G root, and every byte is downloaded back and compared before the pointer is switched.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile, parseConfig, API_DIR } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { evidenceRepo } from "../src/db/evidence.ts";
import { loadOrgFixtures, orgRepo, clusterIdOf } from "../src/db/org.ts";
import { ZeroGReplicaStore } from "../src/replica/replica.ts";

loadEnvFile();
const c = parseConfig(process.env);
if (!c.ZEROG_STORAGE_RPC || !c.ZEROG_STORAGE_INDEXER || !c.ZEROG_PRIVATE_KEY) throw new Error("ZEROG_STORAGE_RPC / ZEROG_STORAGE_INDEXER / ZEROG_PRIVATE_KEY must be set in apps/api/.env");
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const all = process.argv.includes("--all");
const cluster = arg("cluster") ?? (all ? undefined : "software.ic");
const cycle = arg("cycle") ?? "cyc_2026h2";
const limit = Number(arg("limit") ?? 10_000);

const db = openDb(c.dbPath);
loadOrgFixtures(db);
const org = orgRepo(db);
const ev = evidenceRepo(db);
const store = new ZeroGReplicaStore(c.ZEROG_STORAGE_RPC, c.ZEROG_STORAGE_INDEXER, c.ZEROG_PRIVATE_KEY);
const localDir = join(API_DIR, "data", "replica");

const people = org.employees().filter((e) => (cluster ? clusterIdOf(e) === cluster : true));
const rows = people.flatMap((e) => ev.forEmployeeCycle(e.employee_id, cycle));
// only items whose replica is still the local file (or missing); 0G-rooted items are skipped
const todo = rows.filter((r) => {
  const s = ev.secrets(r.evidence_id);
  if (!s?.payload_enc) return false; // shredded
  if (!r.replica_root) return true;
  return existsSync(join(localDir, `${r.replica_root}.bin`));
}).slice(0, limit);
console.log(`${people.length} people (${cluster ?? "all clusters"}), ${rows.length} evidence items, ${todo.length} to move to 0G Storage`);

let ok = 0;
let failed = 0;
for (const r of todo) {
  const s = ev.secrets(r.evidence_id)!;
  const bytes = Buffer.from(s.payload_enc!, "utf8");
  const t = Date.now();
  try {
    const { root } = await store.put(bytes);
    const back = Buffer.from(await store.get(root));
    if (!back.equals(bytes)) throw new Error("downloaded bytes differ from the uploaded ciphertext");
    ev.setReplica(r.evidence_id, "stored", root);
    ok++;
    console.log(`  ok  ${r.evidence_id} ${r.employee_id} ${r.kind.padEnd(20)} root ${root.slice(0, 18)}…  ${Date.now() - t} ms`);
  } catch (e) {
    failed++;
    console.log(`  ERR ${r.evidence_id} ${(e as Error).message.slice(0, 160)}`);
  }
}
console.log(`\ndone: ${ok} moved to 0G Storage, ${failed} failed`);
db.close();
