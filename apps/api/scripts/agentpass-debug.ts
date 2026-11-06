// Debug: poll World IdP once for each pending Agent Pass checkpoint and print the raw (non-secret) answer.
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { Envelope } from "../src/ledger/envelope.ts";
loadEnvFile();
const c = parseConfig(process.env);
const db = openDb(c.dbPath);
const env = new Envelope(c.DATA_KEY);
const auth = "Basic " + Buffer.from(`${encodeURIComponent(c.WORLD_IDP_CLIENT_ID!)}:${encodeURIComponent(c.WORLD_IDP_CLIENT_SECRET!)}`).toString("base64");
for (const r of db.prepare("SELECT * FROM agent_checkpoints WHERE status='pending' ORDER BY created_at DESC").all() as any[]) {
  const dc = env.decrypt(env.unwrap(r.dek_wrapped), r.device_code_enc);
  const res = await fetch("https://auth.world.org/api/v1/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: auth }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc }).toString() });
  const t: any = await res.json().catch(() => ({}));
  console.log(r.checkpoint_id, r.user_code, res.status, JSON.stringify({ ...t, id_token: t.id_token ? "<present>" : undefined, access_token: t.access_token ? "<present>" : undefined }));
}
process.exit(0);
