// Wires repos, adapters and services. One instance per app (tests get a fresh in-memory DB each).
import type { Config } from "./config.ts";
import { openDb, type DB } from "./db/index.ts";
import { auditRepo } from "./db/audit.ts";
import { claimRepo } from "./db/claims.ts";
import { evidenceRepo } from "./db/evidence.ts";
import { loadOrgFixtures, orgRepo } from "./db/org.ts";
import { chainRepo, scorecardRepo } from "./db/scorecards.ts";
import { Envelope } from "./ledger/envelope.ts";
import { Ledger } from "./ledger/ledger.ts";
import { ComputeService } from "./scoring/compute.ts";
import { ClaimDrafter, MockInference, ZeroGInference, type InferenceClient } from "./ai/inference.ts";
import { LiveWorldVerifier, MockWorldVerifier, type WorldVerifier } from "./world/verifier.ts";
import { ClaimService } from "./claims/service.ts";
import { Jwt } from "./auth/auth.ts";
import { loadContract } from "./contract/openapi.ts";
import { systemClock, type Clock } from "./util.ts";
import { MockChain } from "./chain/mock.ts";
import { ViemChain } from "./chain/viem.ts";
import { ScaledChain } from "./chain/scaled.ts";
import { ChainService } from "./chain/service.ts";
import type { ChainClient } from "./chain/types.ts";
import { ScorecardService } from "./scoring/scorecards.ts";
import { RunService, type Connector } from "./agent/runs.ts";
import { VerifyService } from "./verify/service.ts";
import { buildPublicConfig } from "./routes/meta.ts";
import { defaultReplicaDir, makeReplicaStore, ReplicaService, type ReplicaStore } from "./replica/replica.ts";
import { API_DIR } from "./config.ts";
import { EnsDirectory } from "./ens/directory.ts";
import { EnsCredentials } from "./ens/credentials.ts";
import { SYSTEM_PROMPT } from "./review/reasoning.ts";
import { keccak256, stringToBytes } from "viem";
import { EnsResolver, type EnsLookup } from "./ens/resolver.ts";
import { ClusterService } from "./review/clusters.ts";
import { ContextService } from "./review/context.ts";
import { VaultReader } from "./review/vault.ts";
import { ZeroGReasoner, type Reasoner } from "./review/reasoning.ts";
import { ReviewService } from "./review/reviews.ts";
import { ZkService } from "./zk/zk.ts";

export interface ServiceOverrides {
  clock?: Clock;
  db?: DB;
  inference?: InferenceClient;
  world?: WorldVerifier;
  chain?: ChainClient;
  connector?: Connector;
  replica?: ReplicaStore;
  /** ENS reads; null disables. Default: a public-RPC resolver when ENS_NETWORK != none. */
  ens?: EnsLookup | null;
  /** CR-004 review reasoning; null = deterministic (mock) writer. Default: 0G Private Computer when ZEROG_MODE=live. */
  reasoner?: Reasoner | null;
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
  const replicaStore = o.replica ?? makeReplicaStore(config, defaultReplicaDir(API_DIR), log);
  const replica = new ReplicaService(replicaStore, evidence, log);
  ledger.onIngested = (id) => replica.enqueue(id);
  ledger.onShredded = (root) => void replica.forget(root);

  const mockInference = new MockInference(clock);
  let inference: InferenceClient = o.inference ?? mockInference;
  if (!o.inference && config.ZEROG_MODE === "live") {
    if (config.ZEROG_API_KEY && config.ZEROG_MODEL) inference = new ZeroGInference(config.ZEROG_BASE_URL, config.ZEROG_API_KEY, config.ZEROG_MODEL, clock);
    else log("ZEROG_MODE=live but ZEROG_API_KEY/ZEROG_MODEL missing; using mock inference");
  }
  const drafter = new ClaimDrafter(inference, mockInference, loadContract().schema("ClaimBody"), log);
  const world: WorldVerifier = o.world ?? (config.WORLD_MODE === "live" ? new LiveWorldVerifier(config.WORLD_RP_ID ?? config.WORLD_APP_ID, { environment: config.WORLD_ENVIRONMENT }) : new MockWorldVerifier());
  const claims = new ClaimService(db, claimsRepo, org, ledger, audit, envelope, drafter, world, config, clock);
  const jwt = new Jwt(config.JWT_SECRET);

  const baseChain: ChainClient = o.chain ?? (config.CHAIN_MODE === "live" ? new ViemChain(config) : new MockChain(db, clock));
  const chain: ChainClient = config.CHAIN_AMOUNT_DIVISOR > 1 ? new ScaledChain(baseChain, config.CHAIN_AMOUNT_DIVISOR) : baseChain;
  const chains = chainRepo(db);
  const scorecardSvc = new ScorecardService(db, scorecards, org, compute, audit, envelope, world, config, clock);
  const chainSvc = new ChainService(db, chain, chains, scorecards, scorecardSvc, evidence, org, audit, config, clock);
  const agent = buildPublicConfig(config).agent;
  const agentIdentity = { ens_name: agent.ens_name, address: agent.address, agent_pass: "mock" as const };
  const runs = new RunService(db, org, ledger, audit, clock, agentIdentity, o.connector, inference);
  const ens = new EnsDirectory(config, db, agent.address, log);
  ens.onAgentName((name) => (agentIdentity.ens_name = name));
  ens.start(o.ens !== undefined ? o.ens : config.ENS_NETWORK === "none" ? null : new EnsResolver(config));
  const verify = new VerifyService(evidence, ledger, chains, chain, scorecards, claimsRepo, org);

  // CR-004: clusters, context, 0G-vault-backed review reasoning
  const clusters = new ClusterService(org, compute, evidence, clock);
  const contextSvc = new ContextService(org, evidence, envelope);
  const vault = new VaultReader(evidence, envelope, replicaStore, { timeoutMs: 30_000, concurrency: 8, log });
  let reasoner: Reasoner | null = o.reasoner !== undefined ? o.reasoner : null;
  if (o.reasoner === undefined && config.ZEROG_MODE === "live" && config.ZEROG_API_KEY && config.ZEROG_MODEL) {
    reasoner = new ZeroGReasoner(config.ZEROG_BASE_URL, config.ZEROG_API_KEY, config.ZEROG_MODEL, clock);
  }
  const credentials = new EnsCredentials(config, log);
  if (o.ens === undefined && config.ENS_NETWORK === "sepolia") {
    credentials.publishAgentPrompt(keccak256(stringToBytes(SYSTEM_PROMPT))).catch((e) => log(`review-agent prompt publish failed: ${e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : e}`));
  }
  const reviews = new ReviewService(db, org, evidence, clusters, contextSvc, vault, reasoner, chain, world, audit, config, clock, log, (fn) => chainSvc.exclusive(fn), credentials);

  const zk = new ZkService(db, scorecards, org, envelope, chain, audit, config, clock, (fn) => chainSvc.exclusive(fn));

  return {
    config, clock, db, org, audit, evidence, claimsRepo, scorecards, envelope, ledger, compute, inference, world, claims, jwt,
    chain, chains, scorecardSvc, chainSvc, runs, verify, replica, ens, clusters, contextSvc, reviews, zk,
  };
}
export type Services = ReturnType<typeof buildServices>;
