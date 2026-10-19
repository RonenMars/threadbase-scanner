import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/persistent/migrations";
import { SCHEMA_VERSION } from "../src/persistent/schema";

// v11 adds conversations.name_slots and forces a reparse: rows indexed before
// it have no slots, and a finished transcript is never appended to, so nothing
// else would ever fill them. Starts from a v10 database so only the v11 block
// can produce the column or the reset.
describe("v10 → v11 migration adds name_slots and resets the index cursor", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v11-migration-"));
    db = new Database(join(dir, "index.db"));
    db.exec(`
      CREATE TABLE conversations (
        file_id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL,
        session_id TEXT,
        session_name TEXT,
        provider TEXT NOT NULL DEFAULT 'claude-code',
        timestamp TEXT,
        project_path TEXT,
        branch TEXT,
        account TEXT NOT NULL DEFAULT 'default',
        team_name TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        parent_session_id TEXT,
        subagent_id TEXT,
        parent_session_uuid TEXT,
        preview TEXT,
        is_imported_from_claude INTEGER NOT NULL DEFAULT 0,
        is_imported_from_codex INTEGER NOT NULL DEFAULT 0,
        is_imported_from_cursor INTEGER NOT NULL DEFAULT 0
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
      CREATE TABLE message_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        parser_state TEXT NOT NULL
      );
      INSERT INTO message_checkpoints (source_path, message_index, byte_offset, parser_state)
        VALUES ('/p/a.jsonl', 500, 1024, '{"sessionName":"brave-otter"}');
      INSERT INTO conversations (file_id, source_path, session_id, session_name)
        VALUES (1, '/p/a.jsonl', 'sess-1', 'brave-otter');
      INSERT INTO conversation_files
        (absolute_path, parent_dir, file_name, last_indexed_offset, last_indexed_line, reducer_state)
        VALUES ('/p/a.jsonl', '/p', 'a.jsonl', 4096, 20, '{"sessionName":"brave-otter"}');
    `);
    db.pragma("user_version = 10");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const columns = () =>
    (db.pragma("table_info(conversations)") as { name: string }[]).map((c) => c.name);

  it("adds the name_slots column, null on existing rows", () => {
    expect(columns()).not.toContain("name_slots");
    runMigrations(db);
    expect(columns()).toContain("name_slots");
    const row = db.prepare("SELECT name_slots FROM conversations WHERE file_id = 1").get() as {
      name_slots: string | null;
    };
    expect(row.name_slots).toBeNull();
  });

  it("drops checkpoints whose saved reducer state predates nameSlots", () => {
    runMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_checkpoints").get()).toEqual({ n: 0 });
  });

  it("resets offset, line and reducer_state so the file reparses", () => {
    runMigrations(db);
    const file = db.prepare("SELECT * FROM conversation_files WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    expect(file.last_indexed_offset).toBe(0);
    expect(file.last_indexed_line).toBe(0);
    expect(file.reducer_state).toBeNull();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });
});
