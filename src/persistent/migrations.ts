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
  // Non-destructive: existing rows keep their data and default to 'claude-code'.
  // Guarded on table existence so a fresh DB (table created by SCHEMA_SQL below)
  // skips this entirely.
  if (current >= 1 && current < 2 && tableExists(db, "conversations")) {
    for (const [col, ddl] of [
      [
        "provider",
        // Keep the historical DEFAULT 'threadbase' — v2→v3 below updates these rows.
        "ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'threadbase'",
      ],
      ["kind", "ALTER TABLE conversations ADD COLUMN kind TEXT"],
      ["external_session_id", "ALTER TABLE conversations ADD COLUMN external_session_id TEXT"],
    ] as const) {
      if (!hasColumn(db, "conversations", col)) db.exec(ddl);
    }
  }

  // v2 → v3: rename provider 'threadbase' → 'claude-code'.
  if (current >= 1 && current < 3 && tableExists(db, "conversations")) {
    db.exec("UPDATE conversations SET provider = 'claude-code' WHERE provider = 'threadbase'");
  }

  // v4 → v5: the FTS body split from a single `content` column (fed by the 5 KB
  // head-biased meta.contentSnippet) into text/thinking/tools columns fed by the
  // tail-biased search document. CREATE VIRTUAL TABLE IF NOT EXISTS cannot
  // reshape an existing table, so drop it and let SCHEMA_SQL recreate it.
  //
  // Then force every known file to reindex from byte 0. classify() already
  // returns "reindex" whenever last_indexed_offset === 0, so resetting the
  // cursor is the entire trigger. Without it an unchanged conversation would
  // keep its old FTS row forever — nothing would ever append to it, so nothing
  // would rebuild it.
  //
  // Deliberately cheap: no JSONL is read here. Opening the database must stay in
  // milliseconds; the actual re-parse happens in the next indexAll (newest files
  // first), not inside a pragma migration.
  if (current >= 1 && current < 5) {
    db.exec("DROP TABLE IF EXISTS conversation_messages_fts");
    // A database old enough to still be at v1 can predate some cursor columns,
    // and CREATE TABLE IF NOT EXISTS below won't add them — so reset only what
    // this database actually has.
    if (tableExists(db, "conversation_files")) {
      const assignments: string[] = [];
      if (hasColumn(db, "conversation_files", "last_indexed_offset")) {
        assignments.push("last_indexed_offset = 0");
      }
      if (hasColumn(db, "conversation_files", "last_indexed_line")) {
        assignments.push("last_indexed_line = 0");
      }
      if (hasColumn(db, "conversation_files", "reducer_state")) {
        assignments.push("reducer_state = NULL");
      }
      if (assignments.length > 0) {
        db.exec(`UPDATE conversation_files SET ${assignments.join(", ")}`);
      }
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
