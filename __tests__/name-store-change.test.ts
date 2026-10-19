// A rename in a side store (Codex session_index.jsonl, Cursor meta.json, Copilot
// workspace.yaml) changes no transcript byte, so the cursor-based classify says
// "unchanged". The persistent engine must still re-resolve the name.
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCursorStateDb } from "../src/name-stores";
import { openDatabase } from "../src/persistent/db";
import { ConversationScanner } from "../src/scanner";
import type { ConversationMeta } from "../src/types";

const jsonl = (...rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "name-store-change-"));
  dbPath = join(dir, "index.db");
});
afterEach(() => {
  setCursorStateDb(undefined); // module state, must not leak into the next test
  rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

// Same size, newer mtime is what an in-place rename looks like to the cursor.
const touchLater = (path: string) => utimesSync(path, new Date(), new Date(Date.now() + 5000));

async function scanNames(options: Parameters<ConversationScanner["scan"]>[0]) {
  const scanner = new ConversationScanner({ persistent: { dbPath } });
  try {
    const result = await scanner.scan({ profiles: [], ...options });
    return (result.conversations as ConversationMeta[]).map((c) => c.sessionName);
  } finally {
    scanner.close();
  }
}

describe("side-store renames reach an unchanged transcript", () => {
  it("Codex: a new session_index thread_name renames the session on the next scan", async () => {
    const ID = "01a14abc-0000-7000-8000-000000000002";
    const home = join(dir, ".codex");
    write(
      join(home, "sessions", "2026", "02", "01", `rollout-2026-02-01T10-00-00-${ID}.jsonl`),
      jsonl(
        { type: "session_meta", timestamp: "2026-02-01T10:00:00.000Z", payload: { id: ID } },
        {
          type: "response_item",
          timestamp: "2026-02-01T10:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the login bug" }],
          },
        },
      ),
    );
    const opts = { providers: ["codex-cli"], codexRoots: [join(home, "sessions")] };

    expect(await scanNames(opts)).toEqual(["Fix the login bug"]);

    const index = join(home, "session_index.jsonl");
    write(index, jsonl({ id: ID, thread_name: "Login investigation" }));
    expect(await scanNames(opts)).toEqual(["Login investigation"]);

    write(
      index,
      jsonl({ id: ID, thread_name: "Login investigation" }, { id: ID, thread_name: "Renamed" }),
    );
    touchLater(index);
    expect(await scanNames(opts)).toEqual(["Renamed"]);
  });

  it("Cursor: a new chat meta.json title renames the session on the next scan", async () => {
    const ID = "cur-0001";
    const root = join(dir, ".cursor");
    write(
      join(root, "projects", "p", "agent-transcripts", ID, `${ID}.jsonl`),
      jsonl({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\nhello\n</user_query>" }] },
      }),
    );
    const opts = { providers: ["cursor"], cursorRoots: [join(root, "projects")] };
    expect(await scanNames(opts)).toEqual(["hello"]);

    write(
      join(root, "chats", "hash", ID, "meta.json"),
      JSON.stringify({ title: "Playwright Flow" }),
    );
    expect(await scanNames(opts)).toEqual(["Playwright Flow"]);
  });

  it("Copilot: a new workspace.yaml name renames the session on the next scan", async () => {
    const ID = "cop-0001";
    const sessionDir = join(dir, ".copilot", "session-state", ID);
    write(
      join(sessionDir, "events.jsonl"),
      jsonl(
        {
          type: "session.start",
          id: "e1",
          parentId: null,
          timestamp: "2026-02-01T10:00:00.000Z",
          data: { sessionId: ID, context: { cwd: "/work/app" } },
        },
        {
          type: "user.message",
          id: "e2",
          parentId: "e1",
          timestamp: "2026-02-01T10:00:01.000Z",
          data: { content: "How do I build it?" },
        },
        {
          type: "assistant.message",
          id: "e3",
          parentId: "e2",
          timestamp: "2026-02-01T10:00:02.000Z",
          data: { content: "Run npm build." },
        },
      ),
    );
    const opts = { providers: ["copilot"], copilotRoots: [join(dir, ".copilot", "session-state")] };
    expect(await scanNames(opts)).toEqual(["How do I build it?"]);

    write(join(sessionDir, "workspace.yaml"), `id: ${ID}\nname: Extension build\n`);
    expect(await scanNames(opts)).toEqual(["Extension build"]);
  });

  it("an unchanged store leaves the row alone", async () => {
    const ID = "01a14abc-0000-7000-8000-000000000003";
    const home = join(dir, ".codex");
    write(
      join(home, "sessions", `rollout-${ID}.jsonl`),
      jsonl(
        { type: "session_meta", timestamp: "2026-02-01T10:00:00.000Z", payload: { id: ID } },
        {
          type: "response_item",
          timestamp: "2026-02-01T10:00:01.000Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        },
      ),
    );
    write(join(home, "session_index.jsonl"), jsonl({ id: ID, thread_name: "Named" }));
    const opts = { providers: ["codex-cli"], codexRoots: [join(home, "sessions")] };
    expect(await scanNames(opts)).toEqual(["Named"]);
    expect(await scanNames(opts)).toEqual(["Named"]);
  });
});

describe("Cursor IDE state.vscdb (cursorStateDb option)", () => {
  const ID = "ide-0001";
  const setName = (dbFile: string, name: string) => {
    const db = new Database(dbFile);
    db.exec(
      "CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `composerData:${ID}`,
      JSON.stringify({ name }),
    );
    db.close();
  };
  const transcript = () =>
    write(
      join(dir, ".cursor", "projects", "p", "agent-transcripts", ID, `${ID}.jsonl`),
      jsonl({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>\nhello\n</user_query>" }] },
      }),
    );

  it("names the session from composerData and follows a rename", async () => {
    transcript();
    const stateDb = join(dir, "state.vscdb");
    setName(stateDb, "E2E tests workflow trigger");
    const opts = {
      providers: ["cursor"],
      cursorRoots: [join(dir, ".cursor", "projects")],
      cursorStateDb: stateDb,
    };
    expect(await scanNames(opts)).toEqual(["E2E tests workflow trigger"]);

    setName(stateDb, "Renamed in the IDE");
    expect(await scanNames(opts)).toEqual(["Renamed in the IDE"]);
  });

  it("without the option the IDE store is not read", async () => {
    transcript();
    setName(join(dir, "state.vscdb"), "Never read");
    expect(
      await scanNames({ providers: ["cursor"], cursorRoots: [join(dir, ".cursor", "projects")] }),
    ).toEqual(["hello"]);
  });
});

describe("name_slots on provider rows", () => {
  it("stores the transcript and side-store slots next to session_name", async () => {
    const ID = "01a14abc-0000-7000-8000-000000000004";
    const home = join(dir, ".codex");
    write(
      join(home, "sessions", `rollout-${ID}.jsonl`),
      jsonl(
        { type: "session_meta", timestamp: "2026-02-01T10:00:00.000Z", payload: { id: ID } },
        {
          type: "response_item",
          timestamp: "2026-02-01T10:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the login bug" }],
          },
        },
      ),
    );
    write(join(home, "session_index.jsonl"), jsonl({ id: ID, thread_name: "Login investigation" }));
    await scanNames({ providers: ["codex-cli"], codexRoots: [join(home, "sessions")] });

    const db = openDatabase(dbPath);
    const row = db.prepare("SELECT session_name, name_slots FROM conversations").get() as {
      session_name: string;
      name_slots: string;
    };
    db.close();
    expect(row.session_name).toBe("Login investigation");
    expect(JSON.parse(row.name_slots)).toEqual({
      firstUserMessage: "Fix the login bug",
      toolTitle: "Login investigation",
    });
  });
});
