import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/persistent/migrations";
import { SCHEMA_VERSION } from "../src/persistent/schema";

// v7 changes no schema at all — its entire job is to reset the index cursor so
// every already-indexed rollout reparses. That matters because Codex preview,
// title and messageCount are folded out of the JSONL into reducer_state: without
// the reset, a rollout indexed before the fix keeps its "# AGENTS.md instructions
// for …" preview forever, since nothing appends to a finished rollout.
//
// A schema-only migration is easy to leave untested, and this one was: deleting
// the whole v6 → v7 block left the entire suite green, because the v5 → v6 block
// happens to reset the cursor too and `runMigrations` stamps user_version at the
// end regardless. These tests start from a **v6** database so only the v7 block
// can produce the reset.
describe("v6 → v7 migration resets the index cursor", () => {
  let dir: string;
  let db: Database.Database;

  const cursor = () =>
    db
      .prepare("SELECT * FROM conversation_files WHERE absolute_path = '/p/rollout.jsonl'")
      .get() as Record<string, unknown>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v7-migration-"));
    db = new Database(join(dir, "index.db"));
    // A v6 database: it already has the identity columns, so the v5 → v6 block
    // cannot fire and anything observed below is the v7 block's doing.
    db.exec(`
      CREATE TABLE conversations (
        file_id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL,
        session_id TEXT,
        provider TEXT NOT NULL DEFAULT 'codex-cli',
        timestamp TEXT,
        project_path TEXT,
        branch TEXT,
        account TEXT NOT NULL DEFAULT 'default',
        team_name TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        parent_session_id TEXT,
        subagent_id TEXT,
        parent_session_uuid TEXT,
        preview TEXT
      );
      CREATE TABLE conversation_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        absolute_path TEXT NOT NULL UNIQUE,
        parent_dir TEXT NOT NULL,
        file_name TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT 'default',
        last_indexed_offset INTEGER NOT NULL DEFAULT 0,
        last_indexed_line INTEGER NOT NULL DEFAULT 0,
        reducer_state TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      INSERT INTO conversations (file_id, source_path, session_id, preview)
        VALUES (1, '/p/rollout.jsonl', 'sess-1', '# AGENTS.md instructions for /p');
      INSERT INTO conversation_files
        (absolute_path, parent_dir, file_name, last_indexed_offset, last_indexed_line, reducer_state)
        VALUES ('/p/rollout.jsonl', '/p', 'rollout.jsonl', 8192, 41, '{"messageCount":130}');
    `);
    db.pragma("user_version = 6");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resets offset, line and reducer_state so the rollout reparses", () => {
    // Positive control: the cursor is genuinely advanced beforehand, so the
    // assertions below cannot pass against a database that was already at zero.
    const before = cursor();
    expect(before.last_indexed_offset).toBe(8192);
    expect(before.last_indexed_line).toBe(41);
    expect(before.reducer_state).toBe('{"messageCount":130}');

    runMigrations(db);

    const after = cursor();
    // last_indexed_offset === 0 is the entire reindex trigger: classify()
    // returns "reindex" for it, and the reparse happens in the next indexAll.
    expect(after.last_indexed_offset).toBe(0);
    expect(after.last_indexed_line).toBe(0);
    expect(after.reducer_state).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("keeps the conversation row, stale preview included, for the reparse to overwrite", () => {
    runMigrations(db);

    const row = db.prepare("SELECT * FROM conversations WHERE file_id = 1").get() as Record<
      string,
      unknown
    >;
    // Non-destructive: v7 rebuilds by reparsing, it does not delete. The stale
    // preview persisting here is correct — the next indexAll overwrites it.
    expect(row.session_id).toBe("sess-1");
    expect(row.preview).toBe("# AGENTS.md instructions for /p");
  });

  // A weaker test than the two above, and deliberately kept: reindexing on every
  // boot rather than once would be a serious performance bug on a large corpus.
  // Be honest about what it pins — idempotency here is guarded TWICE, by the
  // function-level `current >= SCHEMA_VERSION` early return and by the block's
  // own `current < 7`. Removing either one alone still passes; only removing
  // both fails this. It is a backstop, not a guard on the v7 block specifically.
  it("does not reindex again on a second run over an already-migrated database", () => {
    runMigrations(db);
    db.prepare(
      "UPDATE conversation_files SET last_indexed_offset = 512 WHERE absolute_path = '/p/rollout.jsonl'",
    ).run();

    runMigrations(db);

    expect(cursor().last_indexed_offset).toBe(512);
  });
});
