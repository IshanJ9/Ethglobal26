-- World ID Agent Pass (auth.world.org): human checkpoints for agent workflows, and the World ID linked to each persona.
CREATE TABLE IF NOT EXISTS agent_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  operation_hash TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | approved | denied | expired | cancelled | used
  device_code_enc TEXT,              -- envelope-encrypted, never returned
  dek_wrapped TEXT,
  user_code TEXT,
  verification_uri TEXT,
  verification_uri_complete TEXT,
  interval_s INTEGER NOT NULL,
  next_poll_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  world_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS world_idp_links (
  persona_id TEXT PRIMARY KEY,
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  UNIQUE (iss, sub)
);
