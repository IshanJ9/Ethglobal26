-- Co-sign provenance: the claim (body + the employee's words) sealed with the claim's key and stored on 0G Storage.
ALTER TABLE claims ADD COLUMN vault_root TEXT;
ALTER TABLE claims ADD COLUMN vault_hash TEXT;
