-- Bonus pool allocations proposed by the 0G agent, and their settlement on the Arc Studio BonusPool.
CREATE TABLE IF NOT EXISTS bonus_allocations (
  allocation_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  settle_json TEXT,
  created_at TEXT NOT NULL
);
