-- CR-004: three-layer reviews (KRA score in cluster, context, 0G reasoning). The full review is kept as JSON;
-- review_hash is what gets anchored on chain.
CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  peer_employee_id TEXT,
  review_json TEXT NOT NULL,
  review_hash TEXT NOT NULL,
  reasoning_source TEXT NOT NULL,
  anchor_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX reviews_by_employee ON reviews (employee_id, cycle_id, created_at);
