// Read-only access to the frozen fixtures in spec/fixtures.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const cache = new Map<string, Json>();
export function specJson(rel: string): Json {
  let v = cache.get(rel);
  if (v === undefined) {
    v = JSON.parse(readFileSync(join(REPO_ROOT, "spec", rel), "utf8"));
    cache.set(rel, v);
  }
  return v;
}

export const seedOrg = () => specJson("fixtures/seed-org.json");
export const seedScenario = () => specJson("fixtures/seed-scenario.json");
