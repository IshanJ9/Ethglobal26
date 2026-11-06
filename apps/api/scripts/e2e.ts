// pnpm e2e:demo  - full story against an in-process API with mock chain/World/0G (fresh in-memory DB).
//                  Set E2E_BASE_URL=http://localhost:8787 to run it against a running server instead.
// pnpm e2e:chain - G2 proof on the LIVE chain from apps/api/.env (CHAIN_MODE=live): anchor + attest +
//                  registerPlan + release (+ the revision path with --full). Uses a fresh random ORG_SECRET so
//                  subject ids never collide with earlier runs. Each run reserves real (testnet) cycle funds.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalReplicaStore } from "../src/replica/replica.ts";
import { loadEnvFile, parseConfig } from "../src/config.ts";
import { buildApp } from "../src/server.ts";
import { runDemoStory, type Client } from "../src/dev/demo-story.ts";

const live = process.argv.includes("--chain");
const full = !live || process.argv.includes("--full");
const t0 = Date.now();

async function main() {
  let client: Client;
  let close = async () => {};
  let reveal: ((id: string) => { value: unknown; salt: string } | null) | undefined;

  if (process.env.E2E_BASE_URL && !live) {
    const base = process.env.E2E_BASE_URL.replace(/\/$/, "");
    client = {
      async call(method, url, body, headers = {}) {
        const res = await fetch(base + url, {
          method,
          headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, json: await res.json().catch(() => null) };
      },
    };
    console.log(`e2e against ${base}`);
  } else {
    loadEnvFile();
    const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: "file::memory:", AUTH_MODE: "dev", WORLD_MODE: "mock", ZEROG_MODE: "mock", LOG_LEVEL: "warn" };
    if (live) {
      if (env.CHAIN_MODE !== "live") throw new Error("e2e:chain needs CHAIN_MODE=live in apps/api/.env (copy values from deployments/arc.json)");
      env.ORG_SECRET = "0x" + randomBytes(32).toString("hex");
    } else {
      env.CHAIN_MODE = "mock";
    }
    const config = parseConfig(env);
    const app = await buildApp(config, { logger: false, services: { replica: new LocalReplicaStore(mkdtempSync(join(tmpdir(), "pw-e2e-replica-"))) } });
    client = {
      async call(method, url, body, headers = {}) {
        const res = await app.inject({ method: method as any, url, headers, ...(body !== undefined ? { payload: body as any } : {}) });
        let json: any = null;
        try {
          json = res.json();
        } catch {}
        return { status: res.statusCode, json };
      },
    };
    reveal = (id) => app.svc.scorecardSvc.reveal(id);
    close = async () => {
      if (app.contractGuard.violations.length) {
        console.error("CONTRACT VIOLATIONS:", JSON.stringify(app.contractGuard.violations, null, 2));
        process.exitCode = 1;
      }
      await app.close();
    };
    console.log(`e2e in-process (chain_mode=${config.CHAIN_MODE}${live ? `, rpc ${config.RPC_URL}` : ""})`);
  }

  try {
    const out = await runDemoStory(client, { full, log: (l) => console.log(l), revealScorecard: reveal });
    console.log(`\nE2E ${live ? "CHAIN" : "DEMO"} PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(JSON.stringify(out.ids));
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(`\nE2E FAILED: ${(e as Error).message}`);
  process.exit(1);
});
