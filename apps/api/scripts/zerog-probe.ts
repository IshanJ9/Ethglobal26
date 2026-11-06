// pnpm --filter @proofwork/api zerog:probe - one live 0G call of each kind with the values in apps/api/.env
// (U2: are the credits on testnet or mainnet?). Prints only trace metadata, never prompts, outputs or keys.
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { ClaimDrafter, MockInference, ZeroGInference } from "../src/ai/inference.ts";
import { loadContract } from "../src/contract/openapi.ts";
import { ZeroGReplicaStore } from "../src/replica/replica.ts";
import { systemClock } from "../src/util.ts";

loadEnvFile();
const c = parseConfig({ ...process.env, ZEROG_MODE: "live" });
const cycle = { cycle_id: "probe", numeric_id: 1, label: "probe", starts_on: "2026-07-01", ends_on: "2026-12-31", status: "open" as const };

async function inference() {
  if (!c.ZEROG_API_KEY || !c.ZEROG_MODEL) return console.log("inference: SKIPPED (ZEROG_API_KEY / ZEROG_MODEL not set)");
  const live = new ZeroGInference(c.ZEROG_BASE_URL, c.ZEROG_API_KEY, c.ZEROG_MODEL, systemClock);
  let failed: string | null = null;
  const drafter = new ClaimDrafter(live, new MockInference(systemClock), loadContract().schema("ClaimBody"), (_m, d) => (failed = String(d?.error ?? "")));
  const t = Date.now();
  const d = await drafter.draft("On 14 Oct I had a 45 minute call with Acme Bank about the rollout.", cycle, "Acme Bank");
  const r = d.inference;
  console.log(
    `inference: ${r.provider === "0g_private_computer" ? "OK" : "FELL BACK TO MOCK"} in ${Date.now() - t} ms | model=${r.model} request_id=${r.request_id} zg_res_key=${r.zg_res_key ?? "-"} tee_verified=${r.tee_verified} flags=${d.flags.join(",") || "-"}`,
  );
  if (failed) console.log(`  error: ${failed}`);
}

async function storage() {
  if (!c.ZEROG_STORAGE_RPC || !c.ZEROG_STORAGE_INDEXER || !c.ZEROG_PRIVATE_KEY) return console.log("storage: SKIPPED (ZEROG_STORAGE_RPC / ZEROG_STORAGE_INDEXER / ZEROG_PRIVATE_KEY not set)");
  const t = Date.now();
  try {
    const { root } = await new ZeroGReplicaStore(c.ZEROG_STORAGE_RPC, c.ZEROG_STORAGE_INDEXER, c.ZEROG_PRIVATE_KEY).put(new TextEncoder().encode(`proofwork probe ${new Date().toISOString()}`));
    console.log(`storage: OK in ${Date.now() - t} ms | root=${root}`);
  } catch (e) {
    console.log(`storage: FAILED in ${Date.now() - t} ms | ${(e as Error).message.slice(0, 300)}`);
  }
}

await inference();
await storage();
