// Env parsing. Variable names are frozen in the repo-root .env.example.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const SPEC_VERSION = "1.2.0";

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
  SPEC_VERSION: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.string().default("info"),
  /** Global per-IP request budget per minute (internal; not in .env.example). */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(600),
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
  /** On-chain amounts are 1/N of the real ones (testnet funding). 1 = unscaled. */
  CHAIN_AMOUNT_DIVISOR: z.coerce.number().int().positive().default(1),

  WORLD_MODE: mode,
  WORLD_APP_ID: optStr,
  WORLD_RP_ID: optStr,
  WORLD_SIGNING_KEY: optStr,
  /** Expected World environment (internal; production unless testing with the staging simulator). */
  WORLD_ENVIRONMENT: z.enum(["production", "staging", "sandbox"]).default("production"),

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
  /** RPC for ENS reads; defaults to a public node for ENS_NETWORK. */
  ENS_RPC_URL: optStr,
});

export type Config = z.infer<typeof schema> & { dbPath: string };

/** Strip inline `# comments` that .env.example puts after values. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v === undefined ? v : v.replace(/\s+#.*$/, "").trim();
  return out;
}

/**
 * Loads apps/api/.env. On a fresh clone (no .env) outside production, falls back to the repo-root
 * .env.example so `pnpm install && seed:reset && pnpm dev` works with mocks out of the box; those values
 * are public TEST placeholders, never use them for anything real (run `keys:gen` for your own).
 */
export function loadEnvFile(path = join(API_DIR, ".env")): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
    return;
  }
  const example = join(REPO_ROOT, ".env.example");
  if (process.env.NODE_ENV !== "production" && existsSync(example)) {
    process.loadEnvFile(example);
    console.warn("[proofwork] apps/api/.env not found: using .env.example TEST placeholders (mock mode). Run `pnpm --filter @proofwork/api keys:gen` for real secrets.");
  }
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const res = schema.safeParse(cleanEnv(env));
  if (!res.success) {
    // Only variable names and messages - never values.
    const issues = res.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration (see .env.example):\n${issues}`);
  }
  const c = res.data;
  if (c.SPEC_VERSION && c.SPEC_VERSION !== SPEC_VERSION) {
    console.warn(`[proofwork] SPEC_VERSION=${c.SPEC_VERSION} in the environment; this build implements spec ${SPEC_VERSION} (the build wins).`);
  }
  if (c.CHAIN_MODE === "live") {
    const missing = (["RPC_URL", "ANCHOR_PRIVATE_KEY", "PAYOUT_PRIVATE_KEY"] as const).filter((k) => !c[k]);
    if (missing.length) throw new Error(`CHAIN_MODE=live requires: ${missing.join(", ")}`);
  }
  if (c.NODE_ENV === "production" && c.WEB_ORIGIN.split(",").some((o) => o.trim() === "*")) {
    throw new Error("WEB_ORIGIN must list explicit origins in production (no '*')");
  }
  const rel = c.DATABASE_URL.replace(/^file:/, "");
  const dbPath = rel === ":memory:" ? rel : resolve(API_DIR, rel);
  return { ...c, dbPath };
}
