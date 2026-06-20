import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/persistent/db";
import { ConversationFilesRepo } from "../src/persistent/repositories/conversation-files.repo";
import { ConversationsRepo } from "../src/persistent/repositories/conversations.repo";
import { SCHEMA_VERSION } from "../src/persistent/schema";
import type { ConversationMeta } from "../src/types";

// Open a DB without running migrations — used to hand-build a v1-shaped database
// the migration runner then upgrades.
const openDatabaseRaw = (path: string) => new Database(path);

function sampleMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: "/abs/proj/sess.jsonl",
    filePath: "/abs/proj/sess.jsonl",
    provider: "claude-code",
    sessionId: "sess-1",
    sessionName: "my-session",
    projectPath: "/abs/proj",
    projectName: "proj",
    account: "default",
    timestamp: "2026-01-15T10:05:00.000Z",
    messageCount: 4,
    lastMessageSender: "assistant",
    preview: "hello there",
    contentSnippet: "hello there general kenobi",
    gitBranch: "main",
    model: "claude-opus-4-8",
    isSubagent: false,
    parentSessionId: null,
    isTeammate: false,
    teamName: null,
    toolNames: ["Read", "Edit"],
    firstMessage: { text: "first", timestamp: "2026-01-15T10:00:00.000Z" },
    lastMessage: { text: "last", timestamp: "2026-01-15T10:05:00.000Z" },
    lastPrompt: "do the thing",
    ...overrides,
  };
}

describe("persistent db scaffolding", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-db-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a fresh db and is idempotent on reopen", () => {
    const dbPath = join(dir, "index.db");
    const db1 = openDatabase(dbPath);
    expect(db1.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db1.close();

    // Reopen — migrations should no-op, schema intact.
    const db2 = openDatabase(dbPath);
    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["conversation_files", "conversations"]),
    );
    db2.close();
  });

  it("migrates a v1 db to v2 non-destructively (adds provider columns, keeps rows)", () => {
    const dbPath = join(dir, "v1.db");
    // Build a minimal v1-shaped DB by hand: a conversations table WITHOUT the
    // v2 provider columns, stamped user_version = 1, with one existing row.
    {
      const v1 = openDatabaseRaw(dbPath);
      // Columns below cover every field the v1 indexes (recreated by SCHEMA_SQL)
      // reference, so the post-ALTER db.exec(SCHEMA_SQL) succeeds — the same
      // shape a real v1 database has, minus the v2 provider columns.
      v1.exec(`CREATE TABLE conversation_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT, absolute_path TEXT NOT NULL UNIQUE,
          parent_dir TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '',
          account TEXT NOT NULL DEFAULT 'default', status TEXT NOT NULL DEFAULT 'active');
        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL UNIQUE,
          source_path TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
          project_path TEXT, account TEXT NOT NULL DEFAULT 'default', branch TEXT,
          message_count INTEGER NOT NULL DEFAULT 0, timestamp TEXT,
          index_seq INTEGER NOT NULL DEFAULT 0, is_subagent INTEGER NOT NULL DEFAULT 0,
          team_name TEXT, status TEXT NOT NULL DEFAULT 'active');
        INSERT INTO conversation_files (id, absolute_path) VALUES (1, '/abs/legacy.jsonl');
        INSERT INTO conversations (file_id, source_path, session_id, message_count) VALUES (1, '/abs/legacy.jsonl', 'legacy-1', 7);`);
      v1.pragma("user_version = 1");
      v1.close();
    }

    // openDatabase runs migrations. The pre-existing row must survive and gain a
    // provider updated to 'claude-code' by v2→v3 migration.
    const db = openDatabase(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const row = db
      .prepare(
        "SELECT source_path, provider, kind, external_session_id, message_count FROM conversations WHERE source_path = ?",
      )
      .get("/abs/legacy.jsonl") as Record<string, unknown>;
    expect(row.message_count).toBe(7);
    expect(row.provider).toBe("claude-code");
    expect(row.kind).toBeNull();
    expect(row.external_session_id).toBeNull();
    db.close();
  });

  it("round-trips a ConversationMeta through upsert -> read identically", () => {
    const db = openDatabase(":memory:");
    const files = new ConversationFilesRepo(db);
    const convos = new ConversationsRepo(db);

    const meta = sampleMeta();
    const fileId = files.ensure(meta.filePath, meta.account);
    convos.upsert(fileId, meta);

    expect(convos.getBySourcePath(meta.id)).toEqual(meta);
    db.close();
  });

  it("upsert by file_id overwrites the prior summary in place", () => {
    const db = openDatabase(":memory:");
    const files = new ConversationFilesRepo(db);
    const convos = new ConversationsRepo(db);

    const meta = sampleMeta();
    const fileId = files.ensure(meta.filePath, meta.account);
    convos.upsert(fileId, meta);
    convos.upsert(fileId, sampleMeta({ messageCount: 9, preview: "updated" }));

    expect(convos.count()).toBe(1);
    const back = convos.getBySourcePath(meta.id);
    expect(back?.messageCount).toBe(9);
    expect(back?.preview).toBe("updated");
    db.close();
  });

  it("dual lookup resolves by source_path and by session_id", () => {
    const db = openDatabase(":memory:");
    const files = new ConversationsRepoSetup(db);
    files.add(sampleMeta());

    const convos = new ConversationsRepo(db);
    expect(convos.getByIdOrSession("/abs/proj/sess.jsonl")?.sessionId).toBe("sess-1");
    expect(convos.getByIdOrSession("sess-1")?.id).toBe("/abs/proj/sess.jsonl");
    expect(convos.getByIdOrSession("nope")).toBeNull();
    db.close();
  });

  it("distinctProjects returns active project paths sorted", () => {
    const db = openDatabase(":memory:");
    const setup = new ConversationsRepoSetup(db);
    setup.add(
      sampleMeta({ id: "/a/sess.jsonl", filePath: "/a/sess.jsonl", projectPath: "/z/proj" }),
    );
    setup.add(
      sampleMeta({ id: "/b/sess.jsonl", filePath: "/b/sess.jsonl", projectPath: "/a/proj" }),
    );

    const convos = new ConversationsRepo(db);
    expect(convos.distinctProjects()).toEqual(["/a/proj", "/z/proj"]);
    db.close();
  });
});

// Small helper to insert metas through the real repos.
class ConversationsRepoSetup {
  private files: ConversationFilesRepo;
  private convos: ConversationsRepo;
  constructor(db: import("../src/persistent/db").DB) {
    this.files = new ConversationFilesRepo(db);
    this.convos = new ConversationsRepo(db);
  }
  add(meta: ConversationMeta): void {
    const fileId = this.files.ensure(meta.filePath, meta.account);
    this.convos.upsert(fileId, meta);
  }
}
