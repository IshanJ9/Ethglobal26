import type { FastifyInstance } from "fastify";
import { keccak256, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseConfig, type Config } from "../src/config.ts";
import { buildApp } from "../src/server.ts";
import type { ServiceOverrides } from "../src/services.ts";
import type { Clock } from "../src/util.ts";

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

export const testApp = (overrides: Record<string, string> = {}, services?: ServiceOverrides) =>
  buildApp(testConfig(overrides), { logger: false, services });

/** spec/vectors persona_key_rule: keccak256(utf8('proofwork-demo-persona:' + persona_id)). DEMO ONLY. */
export const personaAccount = (personaId: string) => privateKeyToAccount(keccak256(stringToBytes(`proofwork-demo-persona:${personaId}`)));

export async function login(app: FastifyInstance, personaId: string): Promise<Record<string, string>> {
  const res = await app.inject({ method: "POST", url: "/v1/dev/login", payload: { persona_id: personaId } });
  if (res.statusCode !== 200) throw new Error(`login ${personaId}: ${res.statusCode} ${res.body}`);
  return { authorization: `Bearer ${res.json().token}` };
}

export const CONNECTOR = { "x-connector-key": "test-connector-key" };

/** A clock tests can move forward. */
export class TestClock implements Clock {
  constructor(public t = new Date("2026-11-06T10:00:00Z")) {}
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/** Fails the test if the response guard caught any drift. */
export function expectNoViolations(app: FastifyInstance) {
  if (app.contractGuard.violations.length) throw new Error("contract violations: " + JSON.stringify(app.contractGuard.violations, null, 2));
}

export const hex = (s: string) => s as Hex;
