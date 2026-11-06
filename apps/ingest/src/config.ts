import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const INGEST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Loads apps/ingest/.env into process.env (without overriding real env vars). */
export function loadEnvFile(file = join(INGEST_DIR, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
}

const schema = z.object({
  API_BASE_URL: z.string().url().default("http://localhost:8787"),
  WEB_BASE_URL: z.string().url().default("http://localhost:3000"),
  CONNECTOR_KEY: z.string().min(8),
  LINK_SECRET: z.string().min(16),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(), // owner/name, for the backfill script
  GITHUB_LOGIN_MAP: z.string().default(""), // "login=emp_dev_a,other=emp_dev_b"
  INGEST_PORT: z.coerce.number().int().positive().default(8788),
  INGEST_CYCLE_ID: z.string().optional(),
  COSIGNER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default("0xDD0F57c26b23999240Fd524Ee43a4f918BbA7415"), // seed p_client_cfo
  COSIGNER_LABEL: z.string().default("Client CFO, Acme Bank"),
  BINDINGS_FILE: z.string().default(join(INGEST_DIR, "data", "bindings.json")),
});
export type IngestConfig = z.infer<typeof schema>;

export function parseConfig(env: Record<string, string | undefined> = process.env): IngestConfig {
  const r = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
  if (!r.success) throw new Error("apps/ingest config: " + r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}
