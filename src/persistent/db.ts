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

  let db: DB;
  try {
    db = new Database(dbPath);
  } catch (err) {
    if (isNativeBindingFailure(err)) throw nativeBindingError(err, dbPath);
    throw err;
  }

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

// better-sqlite3 is a native addon, and `require()` of it succeeds even when its
// binary is absent — the JS entry point loads fine and the addon is only touched
// when a Database is constructed. So a broken install stays invisible until this
// exact line, then fails with an opaque list of candidate .node paths that reads
// like an ABI mismatch and sends people chasing Node versions.
//
// It usually isn't an ABI mismatch: the path in the message is normally correct
// for the running Node, and the file simply was never produced.
function isNativeBindingFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /could not locate the bindings file|NODE_MODULE_VERSION|was compiled against|\.node['"\s]/i.test(
    message,
  );
}

function nativeBindingError(err: unknown, dbPath: string): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    [
      `Could not load better-sqlite3's native binary, so the persistent index at ${dbPath} cannot be opened.`,
      "This usually means the binary was never built or downloaded — not that your Node version is wrong.",
      "",
      "Try, in order:",
      "  1. npm rebuild better-sqlite3",
      "  2. rm -rf node_modules && npm install",
      "     (npm 12 blocks package install scripts by default; approve better-sqlite3 if asked)",
      "  3. Run without SQLite entirely: new ConversationScanner({ persistent: false })",
      "     or pass --no-persist on the CLI. Search falls back to the in-memory index.",
      "",
      `Original error: ${detail}`,
    ].join("\n"),
  );
}
