import type { Database } from "better-sqlite3";
import { getLogger } from "../logger";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

// Minimal migration runner gated by PRAGMA user_version. The whole schema uses
// CREATE TABLE/INDEX IF NOT EXISTS, so a fresh DB and an up-to-date DB both
// no-op safely. When SCHEMA_VERSION bumps in the future, add ALTER statements
// keyed on the stored version before stamping the new version.
export function runMigrations(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  const log = getLogger();
  log.info({ from: current, to: SCHEMA_VERSION }, "migrations: applying");

  // v1 → v2: add provider columns to a pre-existing conversations table BEFORE
  // running SCHEMA_SQL, because SCHEMA_SQL now creates indexes on those columns.
  // CREATE TABLE IF NOT EXISTS can't add columns, so ALTER the existing one.
  // Non-destructive: existing rows keep their data and default to 'threadbase'.
  // Guarded on table existence so a fresh DB (table created by SCHEMA_SQL below)
  // skips this entirely.
  if (current >= 1 && current < 2 && tableExists(db, "conversations")) {
    for (const [col, ddl] of [
      [
        "provider",
        "ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'threadbase'",
      ],
      ["kind", "ALTER TABLE conversations ADD COLUMN kind TEXT"],
      ["external_session_id", "ALTER TABLE conversations ADD COLUMN external_session_id TEXT"],
    ] as const) {
      if (!hasColumn(db, "conversations", col)) db.exec(ddl);
    }
  }

  // Fresh DB and re-runs both no-op safely (CREATE ... IF NOT EXISTS). Creates
  // any missing tables/indexes, including the new provider indexes.
  db.exec(SCHEMA_SQL);

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

function tableExists(db: Database, table: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}
