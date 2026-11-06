-- World ID nullifiers are fixed per (person, action): one manager approves many scorecards with the same nullifier.
-- Replay protection is per (nullifier, context = action:object_id); each proof is also bound to that object's signal.
CREATE TABLE world_nullifiers_v2 (
  nullifier TEXT NOT NULL,
  context TEXT NOT NULL,
  used_at TEXT NOT NULL,
  PRIMARY KEY (nullifier, context)
) STRICT;
INSERT INTO world_nullifiers_v2 (nullifier, context, used_at) SELECT nullifier, context, used_at FROM world_nullifiers;
DROP TABLE world_nullifiers;
ALTER TABLE world_nullifiers_v2 RENAME TO world_nullifiers;
