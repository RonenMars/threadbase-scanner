import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliProvider, parseCodexConversation } from "../src/providers/codex-cli";
import { CopilotProvider, parseCopilotConversation } from "../src/providers/copilot";
import { CursorProvider, parseCursorConversation } from "../src/providers/cursor";
import { parseMetaWithProvider } from "../src/providers/parse";

const TIER = { name: "standard", previewMax: 200, snippetMax: 5000 };
const jsonl = (...rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "name-providers-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

describe("Codex session name", () => {
  const ID = "01a14abc-0000-7000-8000-000000000001";
  const userTurn = (text: string) => ({
    type: "response_item",
    timestamp: "2026-02-01T10:00:01.000Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  const rollout = () => {
    const path = join(
      dir,
      ".codex",
      "sessions",
      "2026",
      "02",
      "01",
      `rollout-2026-02-01T10-00-00-${ID}.jsonl`,
    );
    write(
      path,
      jsonl(
        {
          type: "session_meta",
          timestamp: "2026-02-01T10:00:00.000Z",
          payload: { id: ID, cwd: "/work/app" },
        },
        userTurn("<environment_context>\n  <cwd>/work/app</cwd>\n</environment_context>"),
        userTurn("# AGENTS.md instructions for /work/app\n\nBe terse."),
        userTurn("Use sentry plugin to find the login error\nand explain it"),
        {
          type: "response_item",
          timestamp: "2026-02-01T10:00:09.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "On it." }],
          },
        },
      ),
    );
    return path;
  };
  const name = async (path: string) =>
    (await parseMetaWithProvider(new CodexCliProvider(), path, "codex", TIER))?.sessionName;

  it("skips injected turns and keeps the whole first real prompt", async () => {
    expect(await name(rollout())).toBe("Use sentry plugin to find the login error\nand explain it");
  });

  it("a session_index thread_name beats the first user message", async () => {
    const path = rollout();
    write(
      join(dir, ".codex", "session_index.jsonl"),
      jsonl({ id: ID, thread_name: "Investigate Sentry error" }),
    );
    expect(await name(path)).toBe("Investigate Sentry error");
  });

  it("history.jsonl lastPrompt beats the first message but not the index title", async () => {
    const path = rollout();
    write(join(dir, ".codex", "history.jsonl"), jsonl({ session_id: ID, ts: 1, text: "continue" }));
    expect(await name(path)).toBe("continue");

    write(
      join(dir, ".codex", "session_index.jsonl"),
      jsonl({ id: ID, thread_name: "Investigate Sentry error" }),
    );
    expect(await name(path)).toBe("Investigate Sentry error");
  });

  it("the single-file path names the conversation too", async () => {
    const path = rollout();
    expect((await parseCodexConversation(path, "codex"))?.sessionName).toBe(
      "Use sentry plugin to find the login error\nand explain it",
    );
    write(
      join(dir, ".codex", "session_index.jsonl"),
      jsonl({ id: ID, thread_name: "Investigate Sentry error" }),
    );
    expect((await parseCodexConversation(path, "codex"))?.sessionName).toBe(
      "Investigate Sentry error",
    );
  });
});

describe("Cursor session name", () => {
  const ID = "51b95383-966a-432b-ad6c-8921cd3ad87d";
  const userTurn = (text: string) => ({
    role: "user",
    message: { content: [{ type: "text", text }] },
  });
  const transcript = () => {
    const path = join(
      dir,
      ".cursor",
      "projects",
      "work-app",
      "agent-transcripts",
      ID,
      `${ID}.jsonl`,
    );
    write(
      path,
      jsonl(
        userTurn("plain text with no query wrapper"),
        userTurn(
          "<timestamp>Monday, Feb 1, 2026</timestamp>\n<user_query>\nHow do I reverse a list?\n</user_query>",
        ),
        { role: "assistant", message: { content: [{ type: "text", text: "Use reversed()." }] } },
      ),
    );
    return path;
  };
  const name = async (path: string) =>
    (await parseMetaWithProvider(new CursorProvider(), path, "cursor", TIER))?.sessionName;

  it("uses the first <user_query> text and skips turns without one", async () => {
    expect(await name(transcript())).toBe("How do I reverse a list?");
  });

  it("a chats meta.json title beats the first user message", async () => {
    const path = transcript();
    write(
      join(dir, ".cursor", "chats", "hash1", ID, "meta.json"),
      JSON.stringify({ title: "Playwright Flow" }),
    );
    expect(await name(path)).toBe("Playwright Flow");
  });

  it("the single-file path names the conversation too", async () => {
    const path = transcript();
    expect((await parseCursorConversation(path, "cursor"))?.sessionName).toBe(
      "How do I reverse a list?",
    );
    write(
      join(dir, ".cursor", "chats", "hash1", ID, "meta.json"),
      JSON.stringify({ title: "Playwright Flow" }),
    );
    expect((await parseCursorConversation(path, "cursor"))?.sessionName).toBe("Playwright Flow");
  });
});

describe("Copilot session name", () => {
  const ID = "95ae773c-e4b0-4f08-b505-a1728168e48a";
  const session = () => join(dir, ".copilot", "session-state", ID);
  const events = () => {
    const path = join(session(), "events.jsonl");
    write(
      path,
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
          data: {
            content: "How should I build the extension?",
            transformedContent: "<current_datetime>x</current_datetime> wrapped",
          },
        },
        {
          type: "assistant.message",
          id: "e3",
          parentId: "e2",
          timestamp: "2026-02-01T10:00:02.000Z",
          data: { content: "Run the build." },
        },
      ),
    );
    return path;
  };
  const name = async (path: string) =>
    (await parseMetaWithProvider(new CopilotProvider(), path, "copilot", TIER))?.sessionName;

  it("falls back to the first user.message content", async () => {
    expect(await name(events())).toBe("How should I build the extension?");
  });

  it("a user-named workspace.yaml name wins", async () => {
    const path = events();
    write(join(session(), "workspace.yaml"), `id: ${ID}\nname: My rename\nuser_named: true\n`);
    expect(await name(path)).toBe("My rename");
  });

  it("with no workspace name, sessions.summary names the session", async () => {
    const path = events();
    write(join(session(), "workspace.yaml"), `id: ${ID}\nuser_named: false\n`);
    const db = new Database(join(dir, ".copilot", "session-store.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT)");
    db.prepare("INSERT INTO sessions (id, summary) VALUES (?, ?)").run(ID, "Summarised session");
    db.close();
    expect(await name(path)).toBe("Summarised session");
  });

  it("the single-file path names the conversation too", async () => {
    const path = events();
    expect((await parseCopilotConversation(path, "copilot"))?.sessionName).toBe(
      "How should I build the extension?",
    );
  });
});
