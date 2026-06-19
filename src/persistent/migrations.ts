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

  db.exec(SCHEMA_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
