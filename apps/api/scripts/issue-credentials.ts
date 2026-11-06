// Issue ENS review credentials (r-<hash8>.<parent>) for reviews already anchored on Arc.
//   pnpm --filter @proofwork/api exec tsx scripts/issue-credentials.ts [review_id]
// New anchors issue their credential automatically; this backfills older ones. Idempotent (re-writes records only).
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { loadOrgFixtures, orgRepo } from "../src/db/org.ts";
import { EnsCredentials } from "../src/ens/credentials.ts";
import type { Hex } from "@proofwork/crypto";

loadEnvFile();
const c = parseConfig(process.env);
const creds = new EnsCredentials(c, (m) => console.log(" ", m));
if (!creds.enabled) throw new Error("ENS credentials need ENS_NETWORK=sepolia, ENS_PARENT_NAME, ENS_ISSUER_PRIVATE_KEY, ENS_SUBREGISTRY, ENS_ORG_RESOLVER");
const db = openDb(c.dbPath);
loadOrgFixtures(db);
const org = orgRepo(db);
const only = process.argv[2];
const rows = db.prepare("SELECT review_id, review_json, anchor_json FROM reviews WHERE anchor_json IS NOT NULL").all() as Array<{ review_id: string; review_json: string; anchor_json: string }>;
for (const r of rows.filter((x) => !only || x.review_id === only)) {
  const review = JSON.parse(r.review_json);
  const anchor = JSON.parse(r.anchor_json);
  if (anchor.chain_mode !== "live") continue;
  const emp = org.employee(review.employee_id)!;
  console.log(`${r.review_id} (${emp.display_name}) -> ${creds.nameFor(review.hashes.review_hash)}`);
  const out = await creds.issue({ reviewHash: review.hashes.review_hash as Hex, anchorTx: anchor.tx_hash, chainId: c.CHAIN_ID, owner: emp.wallet_address as Hex, employeeEns: emp.ens_name ?? null, cluster: review.cluster.cluster_id });
  console.log("  ", JSON.stringify(out));
}
process.exit(0);
