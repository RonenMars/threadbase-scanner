import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/persistent/migrations";
import { ConversationFilesRepo } from "../src/persistent/repositories/conversation-files.repo";
import { ConversationsRepo } from "../src/persistent/repositories/conversations.repo";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/persistent/schema";
import type { ConversationMeta } from "../src/types";

// v13 adds conversations.project_root / worktree_path and forces a reparse:
// rows indexed before it have neither, and a finished transcript is never
// appended to, so only a reparse from offset 0 can fill them. Starts from a v12
// database so only the v13 block can produce the columns or the reset.
describe("v12 → v13 migration adds project_root and worktree_path and resets the cursor", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v13-migration-"));
    db = new Database(join(dir, "index.db"));
    // A real v12 database: today's schema minus the two v13 columns.
    db.exec(SCHEMA_SQL);
    db.exec("ALTER TABLE conversations DROP COLUMN project_root");
    db.exec("ALTER TABLE conversations DROP COLUMN worktree_path");
    db.exec(`
      INSERT INTO conversation_files
        (absolute_path, parent_dir, file_name, last_indexed_offset, last_indexed_line, reducer_state)
        VALUES ('/p/a.jsonl', '/p', 'a.jsonl', 4096, 20, '{"x":1}');
      INSERT INTO conversations (file_id, source_path, session_id, project_path)
        VALUES (1, '/p/a.jsonl', 'sess-1', '/p');
    `);
    db.pragma("user_version = 12");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const columns = () =>
    (db.pragma("table_info(conversations)") as { name: string }[]).map((c) => c.name);

  it("adds both columns, null on existing rows", () => {
    expect(columns()).not.toContain("project_root");
    runMigrations(db);
    expect(columns()).toContain("project_root");
    expect(columns()).toContain("worktree_path");
    expect(
      db.prepare("SELECT project_root, worktree_path FROM conversations WHERE file_id = 1").get(),
    ).toEqual({ project_root: null, worktree_path: null });
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

  it("drops checkpoints, so none is restored from before the reparse", () => {
    db.exec(
      "INSERT INTO message_checkpoints (source_path, message_index, line_number, byte_offset, parser_state) VALUES ('/p/a.jsonl', 500, 10, 1024, '{}')",
    );
    runMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_checkpoints").get()).toEqual({ n: 0 });
  });

  it("a second open is a no-op: a cursor advanced after v13 is not reset again", () => {
    runMigrations(db);
    db.exec("UPDATE conversation_files SET last_indexed_offset = 999 WHERE id = 1");
    runMigrations(db);
    expect(db.prepare("SELECT last_indexed_offset AS o FROM conversation_files").get()).toEqual({
      o: 999,
    });
  });
});

describe("conversations repo round-trips projectRoot and worktreePath", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v13-repo-"));
    db = new Database(join(dir, "index.db"));
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const meta = (over: Partial<ConversationMeta>): ConversationMeta => ({
    id: "/p/a.jsonl",
    filePath: "/p/a.jsonl",
    provider: "claude-code",
    sessionId: "s",
    sessionName: "",
    projectPath: "/p",
    projectName: "p",
    account: "default",
    timestamp: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    lastMessageSender: "user",
    preview: "",
    contentSnippet: "",
    gitBranch: null,
    model: null,
    isSubagent: false,
    parentSessionId: null,
    isTeammate: false,
    teamName: null,
    toolNames: [],
    firstMessage: null,
    lastMessage: null,
    ...over,
  });

  const roundTrip = (m: ConversationMeta) => {
    const fileId = new ConversationFilesRepo(db).ensure(m.filePath, m.account);
    const repo = new ConversationsRepo(db);
    repo.upsert(fileId, m);
    return repo.getBySourcePath(m.filePath) as ConversationMeta;
  };

  it("a linked worktree keeps both", () => {
    expect(roundTrip(meta({ projectRoot: "/r", worktreePath: "/p" }))).toMatchObject({
      projectRoot: "/r",
      worktreePath: "/p",
    });
  });

  it("a main checkout keeps projectRoot and a null worktreePath", () => {
    const out = roundTrip(meta({ projectRoot: "/p", worktreePath: null }));
    expect(out.projectRoot).toBe("/p");
    expect(out.worktreePath).toBeNull();
  });

  it("a re-index overwrites both columns, including back to unresolved", () => {
    roundTrip(meta({ projectRoot: "/r", worktreePath: "/p" }));
    expect(roundTrip(meta({ projectRoot: "/r2", worktreePath: null }))).toMatchObject({
      projectRoot: "/r2",
      worktreePath: null,
    });
    expect("projectRoot" in roundTrip(meta({}))).toBe(false);
  });

  it("an unresolved project reads back with both fields unset", () => {
    const out = roundTrip(meta({}));
    expect("projectRoot" in out).toBe(false);
    expect("worktreePath" in out).toBe(false);
  });
});
