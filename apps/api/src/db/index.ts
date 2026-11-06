// SQLite (better-sqlite3, WAL). Plain SQL migrations from apps/api/migrations, applied in order.
import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { API_DIR } from "../config.ts";

export type DB = Database.Database;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").pluck().all() as string[]);
  const dir = join(API_DIR, "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    })();
  }
}

/** JSON helpers for *_json columns. */
export const j = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);
export const js = (v: unknown): string => JSON.stringify(v);
