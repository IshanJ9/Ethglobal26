-- Zero-knowledge score commitments (Poseidon, Groth16 score_threshold circuit). The salt is envelope-encrypted.
CREATE TABLE zk_commitments (
  scorecard_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  score_bps INTEGER NOT NULL,
  commitment TEXT NOT NULL,
  binding TEXT NOT NULL,
  dek_wrapped TEXT NOT NULL,
  salt_enc TEXT NOT NULL,
  anchor_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
