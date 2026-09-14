import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/persistent/migrations";
import { SCHEMA_VERSION } from "../src/persistent/schema";

describe("v7 → v8 migration adds import-provenance columns", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v8-migration-"));
    db = new Database(join(dir, "index.db"));
    db.exec(`
      CREATE TABLE conversations (
        file_id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL,
        session_id TEXT,
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
        last_prompt TEXT
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
      INSERT INTO conversations (file_id, source_path, session_id, provider)
        VALUES (1, '/p/agent-transcripts/a.jsonl', 'cursor-1', 'cursor-cli'),
               (2, '/p/sess.jsonl', 'claude-1', 'claude-code');
      INSERT INTO conversation_files
        (id, absolute_path, parent_dir, file_name, last_indexed_offset, last_indexed_line, reducer_state)
        VALUES
          (1, '/p/agent-transcripts/a.jsonl', '/p', 'a.jsonl', 4096, 12, '{"messageCount":4}'),
          (2, '/p/sess.jsonl', '/p', 'sess.jsonl', 2048, 8, '{"messageCount":2}');
    `);
    db.pragma("user_version = 7");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds the three import columns and reindexes only cursor-cli files", () => {
    runMigrations(db);

    const cols = (db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("is_imported_from_claude");
    expect(cols).toContain("is_imported_from_codex");
    expect(cols).toContain("is_imported_from_cursor");

    const cursor = db.prepare("SELECT * FROM conversation_files WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    expect(cursor.last_indexed_offset).toBe(0);
    expect(cursor.last_indexed_line).toBe(0);
    expect(cursor.reducer_state).toBeNull();

    const claude = db.prepare("SELECT * FROM conversation_files WHERE id = 2").get() as Record<
      string,
      unknown
    >;
    expect(claude.last_indexed_offset).toBe(2048);
    expect(claude.last_indexed_line).toBe(8);

    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });
});
