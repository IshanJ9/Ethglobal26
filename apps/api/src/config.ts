// Env parsing. Variable names are frozen in the repo-root .env.example.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SPEC_VERSION = "1.0.0";

/** apps/api directory and monorepo root, independent of the process cwd. */
export const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(API_DIR, "..", "..");

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x + 64 hex");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x + 40 hex");
const optStr = z.string().optional().transform((v) => (v ? v : undefined));
const optKey = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(bytes32.optional());
const mode = z.enum(["mock", "live"]).default("mock");

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  SPEC_VERSION: z.literal(SPEC_VERSION).default(SPEC_VERSION),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.string().default("info"),
  AUTH_MODE: z.enum(["dev", "sso"]).default("dev"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  ORG_SECRET: bytes32,
  DATA_KEY: bytes32,
  DATABASE_URL: z.string().default("file:./data/proofwork.db"),
  CONNECTOR_KEY: z.string().min(8),

  CHAIN_MODE: mode,
  CHAIN_ID: z.coerce.number().int().positive().default(31337),
  RPC_URL: optStr,
  EXPLORER_BASE_URL: optStr,
  REGISTRY_ADDRESS: address,
  VAULT_ADDRESS: address,
  ASSET_ADDRESS: address,
  ANCHOR_PRIVATE_KEY: optKey,
  PAYOUT_PRIVATE_KEY: optKey,

  WORLD_MODE: mode,
  WORLD_APP_ID: optStr,
  WORLD_RP_ID: optStr,
  WORLD_SIGNING_KEY: optStr,

  ZEROG_MODE: mode,
  ZEROG_BASE_URL: z.string().default("https://router-api.0g.ai/v1"),
  ZEROG_API_KEY: optStr,
  ZEROG_MODEL: optStr,
  ZEROG_STORAGE_RPC: optStr,
  ZEROG_STORAGE_INDEXER: optStr,
  ZEROG_PRIVATE_KEY: optStr,

  ENS_NETWORK: z.enum(["none", "sepolia", "mainnet"]).default("none"),
  ENS_PARENT_NAME: optStr,
  AGENT_ENS_NAME: z.string().default("kra-agent"),
  AGENT_ADDRESS: optStr.pipe(address.optional()),
});

export type Config = z.infer<typeof schema> & { dbPath: string };

/** Strip inline `# comments` that .env.example puts after values. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === undefined ? v : v.replace(/\s+#.*$/, "").trim();
  return out;
}

export function loadEnvFile(path = join(API_DIR, ".env")): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const res = schema.safeParse(cleanEnv(env));
  if (!res.success) {
    // Only variable names and messages - never values.
    const issues = res.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration (see .env.example):\n${issues}`);
  }
  const c = res.data;
  if (c.CHAIN_MODE === "live") {
    const missing = (["RPC_URL", "ANCHOR_PRIVATE_KEY", "PAYOUT_PRIVATE_KEY"] as const).filter((k) => !c[k]);
    if (missing.length) throw new Error(`CHAIN_MODE=live requires: ${missing.join(", ")}`);
  }
  const rel = c.DATABASE_URL.replace(/^file:/, "");
  const dbPath = rel === ":memory:" ? rel : resolve(API_DIR, rel);
  return { ...c, dbPath };
}
