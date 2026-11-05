import { parseConfig, type Config } from "../src/config.ts";
import { buildApp } from "../src/server.ts";

/** Deterministic, mock-everything config for tests. Never reads apps/api/.env. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return parseConfig({
    NODE_ENV: "test",
    JWT_SECRET: "test-jwt-secret-0123456789",
    ORG_SECRET: "0x" + "11".repeat(32),
    DATA_KEY: "0x" + "22".repeat(32),
    CONNECTOR_KEY: "test-connector-key",
    DATABASE_URL: "file::memory:",
    REGISTRY_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    VAULT_ADDRESS: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    ASSET_ADDRESS: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    ...overrides,
  });
}

export const testApp = (overrides: Record<string, string> = {}) => buildApp(testConfig(overrides), { logger: false });
