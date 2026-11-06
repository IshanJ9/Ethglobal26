// Wires repos, adapters and services. One instance per app (tests get a fresh in-memory DB each).
import type { Config } from "./config.ts";
import { openDb, type DB } from "./db/index.ts";
import { auditRepo } from "./db/audit.ts";
import { claimRepo } from "./db/claims.ts";
import { evidenceRepo } from "./db/evidence.ts";
import { loadOrgFixtures, orgRepo } from "./db/org.ts";
import { scorecardRepo } from "./db/scorecards.ts";
import { Envelope } from "./ledger/envelope.ts";
import { Ledger } from "./ledger/ledger.ts";
import { ComputeService } from "./scoring/compute.ts";
import { ClaimDrafter, MockInference, ZeroGInference, type InferenceClient } from "./ai/inference.ts";
import { LiveWorldVerifier, MockWorldVerifier, type WorldVerifier } from "./world/verifier.ts";
import { ClaimService } from "./claims/service.ts";
import { Jwt } from "./auth/auth.ts";
import { loadContract } from "./contract/openapi.ts";
import { systemClock, type Clock } from "./util.ts";

export interface ServiceOverrides {
  clock?: Clock;
  db?: DB;
  inference?: InferenceClient;
  world?: WorldVerifier;
}

export function buildServices(config: Config, o: ServiceOverrides = {}, log: (m: string, d?: Record<string, unknown>) => void = () => {}) {
  const clock = o.clock ?? systemClock;
  const db = o.db ?? openDb(config.dbPath);
  loadOrgFixtures(db); // idempotent: a fresh clone works without running seed:reset first
  const org = orgRepo(db);
  const audit = auditRepo(db);
  const evidence = evidenceRepo(db);
  const claimsRepo = claimRepo(db);
  const scorecards = scorecardRepo(db);
  const envelope = new Envelope(config.DATA_KEY);
  const ledger = new Ledger(db, evidence, org, audit, envelope, clock);
  const compute = new ComputeService(org, evidence, scorecards);

  const mockInference = new MockInference(clock);
  let inference: InferenceClient = o.inference ?? mockInference;
  if (!o.inference && config.ZEROG_MODE === "live") {
    if (config.ZEROG_API_KEY && config.ZEROG_MODEL) inference = new ZeroGInference(config.ZEROG_BASE_URL, config.ZEROG_API_KEY, config.ZEROG_MODEL, clock);
    else log("ZEROG_MODE=live but ZEROG_API_KEY/ZEROG_MODEL missing; using mock inference");
  }
  const drafter = new ClaimDrafter(inference, mockInference, loadContract().schema("ClaimBody"), log);
  const world: WorldVerifier = o.world ?? (config.WORLD_MODE === "live" ? new LiveWorldVerifier() : new MockWorldVerifier());
  const claims = new ClaimService(db, claimsRepo, org, ledger, audit, envelope, drafter, world, config, clock);
  const jwt = new Jwt(config.JWT_SECRET);

  return { config, clock, db, org, audit, evidence, claimsRepo, scorecards, envelope, ledger, compute, inference, world, claims, jwt };
}
export type Services = ReturnType<typeof buildServices>;
