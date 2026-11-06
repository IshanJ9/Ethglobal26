-- Proofwork API schema v1. Timestamps are ISO-8601 UTC strings; money is decimal TEXT.

CREATE TABLE org_personas (
  persona_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  department TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  ens_name TEXT,
  manager_employee_id TEXT,
  world_id_verified INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE org_employees (
  employee_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  department TEXT NOT NULL,
  level TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  ens_name TEXT,
  manager_employee_id TEXT
) STRICT;

CREATE TABLE org_cycles (
  cycle_id TEXT PRIMARY KEY,
  numeric_id INTEGER NOT NULL UNIQUE,
  label TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  status TEXT NOT NULL
) STRICT;

CREATE TABLE org_plans (
  plan_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL            -- exact fixture JSON
) STRICT;

CREATE TABLE claims (
  claim_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  kra_id TEXT NOT NULL,
  state TEXT NOT NULL,
  body_json TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  cosigner_address TEXT NOT NULL,
  cosigner_label TEXT NOT NULL,
  ai_flags_json TEXT NOT NULL DEFAULT '[]',
  inference_json TEXT,
  frozen_at TEXT,                    -- set when the signing package is issued
  typed_data_json TEXT,
  digest TEXT,
  claim_commitment TEXT,
  evidence_commitment TEXT,
  nonce INTEGER,
  deadline INTEGER,
  employee_sig TEXT,
  cosigner_sig TEXT,
  evidence_id TEXT,
  decline_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX claims_emp ON claims(employee_id, cycle_id);

CREATE TABLE claim_secrets (
  claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id),
  dek_wrapped TEXT,
  claim_salt_enc TEXT,
  evidence_salt_enc TEXT
) STRICT;

CREATE TABLE cosign_grants (
  grant_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  auth_method TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  world_action TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  closed_reason TEXT                 -- signed | declined | expired | revoked
) STRICT;

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT,
  status TEXT NOT NULL,
  status_at_ingest TEXT NOT NULL,    -- the status hashed into the chain link
  observed_at TEXT NOT NULL,
  observations_json TEXT NOT NULL,
  severity TEXT,
  self_introduced INTEGER NOT NULL DEFAULT 0,
  share_bps INTEGER NOT NULL DEFAULT 10000,
  flags_json TEXT NOT NULL DEFAULT '[]',
  reverts_evidence_id TEXT,
  supersedes_evidence_id TEXT,
  claim_id TEXT,
  commitment TEXT NOT NULL,
  batch_id TEXT,
  seq INTEGER NOT NULL UNIQUE,
  prev_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  shredded_at TEXT
) STRICT;
CREATE UNIQUE INDEX evidence_dedupe ON evidence(source, kind, ref) WHERE ref IS NOT NULL;
CREATE INDEX evidence_emp ON evidence(employee_id, cycle_id);

CREATE TABLE evidence_secrets (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence(evidence_id),
  dek_wrapped TEXT,
  salt_enc TEXT,
  payload_enc TEXT,
  replica_root TEXT,
  replica_status TEXT NOT NULL DEFAULT 'none'
) STRICT;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  status TEXT NOT NULL,
  tool_calls_json TEXT NOT NULL DEFAULT '[]',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  inference_json TEXT,
  agent_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE TABLE scorecards (
  scorecard_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  supersedes_id TEXT,
  reason TEXT,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  evidence_root TEXT,
  score_commitment TEXT,
  score_salt_enc TEXT,
  score_object_json TEXT,
  subject_id TEXT,
  approval_id TEXT,
  needs_revision INTEGER NOT NULL DEFAULT 0,
  attestation_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (employee_id, cycle_id, version)
) STRICT;

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  scorecard_id TEXT NOT NULL,
  status TEXT NOT NULL,
  challenge TEXT NOT NULL,
  nonce TEXT NOT NULL,
  world_action TEXT NOT NULL,
  approver_employee_id TEXT,
  comment TEXT,
  proof_hash TEXT,
  world_result_hash TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
) STRICT;

CREATE TABLE world_nullifiers (
  nullifier TEXT PRIMARY KEY,
  context TEXT NOT NULL,
  used_at TEXT NOT NULL
) STRICT;

CREATE TABLE batches (
  batch_id TEXT PRIMARY KEY,
  numeric_id INTEGER NOT NULL UNIQUE,
  root TEXT NOT NULL,
  count INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  chain_mode TEXT NOT NULL,
  anchored_at TEXT NOT NULL
) STRICT;

CREATE TABLE batch_items (
  batch_id TEXT NOT NULL REFERENCES batches(batch_id),
  evidence_id TEXT NOT NULL,
  leaf_index INTEGER NOT NULL,
  proof_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, evidence_id)
) STRICT;

CREATE TABLE attestations (
  attestation_id INTEGER PRIMARY KEY,
  scorecard_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  supersedes_id INTEGER,
  tx_hash TEXT NOT NULL,
  chain_mode TEXT NOT NULL,
  attested_at TEXT NOT NULL
) STRICT;

CREATE TABLE payouts (
  scorecard_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  payee TEXT NOT NULL,
  target_bonus TEXT NOT NULL,
  entitlement TEXT NOT NULL,
  paid TEXT NOT NULL,
  held TEXT NOT NULL,
  forfeited TEXT NOT NULL,
  overpaid TEXT NOT NULL,
  maturity_at TEXT,
  last_tx TEXT
) STRICT;

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL
) STRICT;

CREATE TABLE idempotency (
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, route)
) STRICT;

-- Mock chain state (CHAIN_MODE=mock) persists here so restarts keep it.
CREATE TABLE mockchain_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) STRICT;
