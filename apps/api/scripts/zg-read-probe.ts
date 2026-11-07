// Probe: read sealed evidence back from 0G Storage by root (no secrets printed).
import Database from "better-sqlite3";
import { loadEnvFile, parseConfig } from "../src/config.ts";
loadEnvFile();
import { ZeroGReplicaStore } from "../src/replica/replica.ts";
const c: any = parseConfig();
const store = new ZeroGReplicaStore(c.ZEROG_STORAGE_RPC, c.ZEROG_STORAGE_INDEXER, c.ZEROG_PRIVATE_KEY);
const db = new Database("data/proofwork.db", { readonly: true });
const counts = db.prepare("SELECT s.replica_status, COUNT(*) n FROM evidence_secrets s GROUP BY s.replica_status").all();
console.log(counts);
const rows = db.prepare("SELECT e.evidence_id, e.employee_id, s.replica_root, e.created_at FROM evidence e JOIN evidence_secrets s USING(evidence_id) WHERE s.replica_status='stored' AND s.replica_root IS NOT NULL ORDER BY e.rowid DESC LIMIT 3").all() as any[];
const old = db.prepare("SELECT e.evidence_id, e.employee_id, s.replica_root, e.created_at FROM evidence e JOIN evidence_secrets s USING(evidence_id) WHERE s.replica_status='stored' AND s.replica_root IS NOT NULL AND e.employee_id='emp_dev_c' LIMIT 2").all() as any[];
for (const r of [...rows, ...old]) {
  const t = Date.now();
  try { const b = await store.get(r.replica_root); console.log("OK ", r.evidence_id, r.created_at, b.length, "bytes", Date.now() - t, "ms"); }
  catch (e) { console.log("ERR", r.evidence_id, r.created_at, (e as Error).message.slice(0, 80), Date.now() - t, "ms"); }
}
