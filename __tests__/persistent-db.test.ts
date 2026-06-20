import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/persistent/db";
import { ConversationFilesRepo } from "../src/persistent/repositories/conversation-files.repo";
import { ConversationsRepo } from "../src/persistent/repositories/conversations.repo";
import type { ConversationMeta } from "../src/types";

function sampleMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: "/abs/proj/sess.jsonl",
    filePath: "/abs/proj/sess.jsonl",
    provider: "threadbase",
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
    expect(db1.pragma("user_version", { simple: true })).toBe(1);
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
