import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCodexNameSlots,
  readCopilotNameSlots,
  readCursorCliNameSlots,
  readCursorIdeNameSlots,
} from "../src/name-stores";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "name-stores-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const jsonl = (...rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

function sqlite(path: string, ddl: string, ...inserts: Array<[string, unknown[]]>) {
  const db = new Database(path);
  db.exec(ddl);
  for (const [sql, params] of inserts) db.prepare(sql).run(...params);
  db.close();
}

describe("readCodexNameSlots", () => {
  const ID = "01a14abc";

  it("takes the last session_index line for the id as toolTitle, skipping corrupt lines", () => {
    writeFileSync(
      join(dir, "session_index.jsonl"),
      `${jsonl({ id: ID, thread_name: "Old name" }, { id: "other", thread_name: "Nope" })}not json\n${jsonl({ id: ID, thread_name: "Investigate Sentry error" })}`,
    );
    expect(readCodexNameSlots(dir, ID)).toEqual({ toolTitle: "Investigate Sentry error" });
  });

  it("takes the last history line for the id as lastPrompt", () => {
    writeFileSync(
      join(dir, "history.jsonl"),
      jsonl(
        { session_id: ID, ts: 1, text: "first" },
        { session_id: "other", ts: 2, text: "other" },
        { session_id: ID, ts: 3, text: "continue" },
      ),
    );
    expect(readCodexNameSlots(dir, ID)).toEqual({ lastPrompt: "continue" });
  });

  describe("state_5.sqlite threads.name", () => {
    const makeDb = () =>
      sqlite(join(dir, "state_5.sqlite"), "CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT)", [
        "INSERT INTO threads (id, name) VALUES (?, ?)",
        [ID, "From sqlite"],
      ]);

    it("is the fallback when the index has no line for the id", () => {
      makeDb();
      writeFileSync(join(dir, "session_index.jsonl"), jsonl({ id: "other", thread_name: "x" }));
      expect(readCodexNameSlots(dir, ID)).toEqual({ toolTitle: "From sqlite" });
    });

    it("is ignored when the index has a line for the id", () => {
      makeDb();
      writeFileSync(join(dir, "session_index.jsonl"), jsonl({ id: ID, thread_name: "From index" }));
      expect(readCodexNameSlots(dir, ID)).toEqual({ toolTitle: "From index" });
    });

    it("yields {} for a corrupt database", () => {
      writeFileSync(join(dir, "state_5.sqlite"), "this is not sqlite");
      expect(readCodexNameSlots(dir, ID)).toEqual({});
    });
  });

  it("yields {} when nothing exists", () => {
    expect(readCodexNameSlots(dir, ID)).toEqual({});
    expect(readCodexNameSlots(join(dir, "missing"), ID)).toEqual({});
  });
});

describe("readCursorCliNameSlots", () => {
  const ID = "51b95383";
  const chat = () => {
    const d = join(dir, "hash1", ID);
    mkdirSync(d, { recursive: true });
    return d;
  };

  it("reads meta.json title as toolTitle and prompt_history.json[0] as lastPrompt", () => {
    const d = chat();
    writeFileSync(join(d, "meta.json"), JSON.stringify({ title: "Playwright Flow" }));
    writeFileSync(join(d, "prompt_history.json"), JSON.stringify(["newest", "older"]));
    expect(readCursorCliNameSlots(dir, ID)).toEqual({
      toolTitle: "Playwright Flow",
      lastPrompt: "newest",
    });
  });

  describe("store.db meta key 0", () => {
    const makeStore = (d: string) =>
      sqlite(join(d, "store.db"), "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)", [
        "INSERT INTO meta (key, value) VALUES (?, ?)",
        ["0", Buffer.from(JSON.stringify({ name: "From store" })).toString("hex")],
      ]);

    it("is the fallback when meta.json has no title", () => {
      const d = chat();
      writeFileSync(join(d, "meta.json"), JSON.stringify({ hasConversation: true }));
      makeStore(d);
      expect(readCursorCliNameSlots(dir, ID)).toEqual({ toolTitle: "From store" });
    });

    it("is ignored when meta.json has a title", () => {
      const d = chat();
      writeFileSync(join(d, "meta.json"), JSON.stringify({ title: "From meta" }));
      makeStore(d);
      expect(readCursorCliNameSlots(dir, ID)).toEqual({ toolTitle: "From meta" });
    });
  });

  it("yields {} for corrupt files, an unknown id, and a missing directory", () => {
    const d = chat();
    writeFileSync(join(d, "meta.json"), "{ not json");
    writeFileSync(join(d, "prompt_history.json"), "nope");
    writeFileSync(join(d, "store.db"), "not sqlite");
    expect(readCursorCliNameSlots(dir, ID)).toEqual({});
    expect(readCursorCliNameSlots(dir, "unknown")).toEqual({});
    expect(readCursorCliNameSlots(join(dir, "missing"), ID)).toEqual({});
  });
});

describe("readCursorIdeNameSlots", () => {
  const ID = "de2aaecc";
  const db = () => join(dir, "state.vscdb");

  it("looks up composerData:<id> and reads $.name as toolTitle", () => {
    sqlite(
      db(),
      "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)",
      [
        "INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)",
        [`composerData:${ID}`, JSON.stringify({ name: "E2E tests workflow trigger" })],
      ],
      [
        "INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)",
        ["composerData:other", JSON.stringify({ name: "Nope" })],
      ],
    );
    expect(readCursorIdeNameSlots(db(), ID)).toEqual({ toolTitle: "E2E tests workflow trigger" });
  });

  it("yields {} for an unknown id, a missing key table, a corrupt file, and a missing file", () => {
    sqlite(db(), "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    expect(readCursorIdeNameSlots(db(), ID)).toEqual({});

    writeFileSync(join(dir, "other.vscdb"), "not sqlite");
    expect(readCursorIdeNameSlots(join(dir, "other.vscdb"), ID)).toEqual({});
    expect(readCursorIdeNameSlots(join(dir, "none.vscdb"), ID)).toEqual({});
  });

  it("opens read-only: never creates a missing database", () => {
    readCursorIdeNameSlots(join(dir, "none.vscdb"), ID);
    expect(existsSync(join(dir, "none.vscdb"))).toBe(false);
  });
});

describe("readCopilotNameSlots", () => {
  const ID = "95ae773c";
  // Mirrors <home>/session-state/<id>/ with <home>/session-store.db beside it.
  const sessionDir = () => {
    const d = join(dir, "session-state", ID);
    mkdirSync(d, { recursive: true });
    return d;
  };

  it("workspace.yaml name with user_named: true is userTitle", () => {
    writeFileSync(
      join(sessionDir(), "workspace.yaml"),
      `id: ${ID}\nname: My rename\nuser_named: true\n`,
    );
    expect(readCopilotNameSlots(sessionDir())).toEqual({ userTitle: "My rename" });
  });

  it("workspace.yaml name with user_named: false is toolTitle, quotes stripped", () => {
    writeFileSync(
      join(sessionDir(), "workspace.yaml"),
      `id: ${ID}\nname: "Chrome extension build"\nuser_named: false\n`,
    );
    expect(readCopilotNameSlots(sessionDir())).toEqual({ toolTitle: "Chrome extension build" });
  });

  it("falls back to session-store.db sessions.summary when workspace.yaml has no name", () => {
    writeFileSync(join(sessionDir(), "workspace.yaml"), `id: ${ID}\nuser_named: false\n`);
    sqlite(
      join(dir, "session-store.db"),
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT)",
      ["INSERT INTO sessions (id, summary) VALUES (?, ?)", [ID, "Summarised session"]],
    );
    expect(readCopilotNameSlots(sessionDir())).toEqual({ toolTitle: "Summarised session" });
  });

  it("reads the first user.message data.content, never transformedContent", () => {
    writeFileSync(
      join(sessionDir(), "events.jsonl"),
      jsonl(
        { type: "session.start", data: {} },
        { type: "assistant.message", data: { content: "hi" } },
        {
          type: "user.message",
          data: {
            content: "How do I build it?",
            transformedContent: "<current_datetime>x</current_datetime> wrapped",
          },
        },
        { type: "user.message", data: { content: "second" } },
      ),
    );
    expect(readCopilotNameSlots(sessionDir())).toEqual({ firstUserMessage: "How do I build it?" });
  });

  it("yields {} for a missing directory and a corrupt database", () => {
    expect(readCopilotNameSlots(join(dir, "nope"))).toEqual({});
    sessionDir();
    writeFileSync(join(dir, "session-store.db"), "not sqlite");
    expect(readCopilotNameSlots(sessionDir())).toEqual({});
  });
});
