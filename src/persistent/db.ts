import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { getLogger } from "../logger";
import { runMigrations } from "./migrations";

export type DB = Database.Database;

// Open (creating if needed) the SQLite index at dbPath, apply WAL pragmas, and
// run migrations. ":memory:" is supported for tests.
export function openDatabase(dbPath: string): DB {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");
  // Let a reader briefly wait out a concurrent indexing write instead of failing
  // immediately with SQLITE_BUSY. Operational resilience only — search recall is
  // unaffected.
  db.pragma("busy_timeout = 5000");

  runMigrations(db);

  getLogger().debug({ dbPath }, "db: opened");
  return db;
}
