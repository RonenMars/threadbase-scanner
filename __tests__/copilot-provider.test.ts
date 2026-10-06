import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliProvider } from "../src/providers/codex-cli";
import {
  CopilotProvider,
  parseCopilotConversation,
  parseCopilotJsonlLine,
} from "../src/providers/copilot";
import { CursorProvider } from "../src/providers/cursor";
import { parseMetaWithProvider } from "../src/providers/parse";
import { canonicalizeProviderName } from "../src/providers/provider";
import { ThreadbaseProvider } from "../src/providers/threadbase";
import { ConversationScanner } from "../src/scanner";
import { extractSearchDelta } from "../src/search-document";
import { resolveTier } from "../src/tiers";
import type { ConversationMeta } from "../src/types";

// Fixtures keep the keys, nesting and event order of real Copilot CLI 1.0.92
// sessions; every value is a placeholder.
const FIXTURES = join(__dirname, "..", "__fixtures__", "copilot");
const CODEX_FIXTURES = join(__dirname, "..", "__fixtures__", "codex-cli");
const CURSOR_FIXTURES = join(__dirname, "..", "__fixtures__", "cursor");
const CLAUDE_FIXTURES = join(__dirname, "..", "__fixtures__");
const TIER = resolveTier("standard");
const BASIC_ID = "00000000-0000-4000-8000-000000000001";
const TOOLS_ID = "00000000-0000-4000-8000-0000000000a1";

function parse(file: string): Promise<ConversationMeta | null> {
  return parseMetaWithProvider(new CopilotProvider(), join(FIXTURES, file), "copilot", TIER);
}

function plant(root: string, sessionId: string, fixture: string): string {
  const dest = join(root, sessionId, "events.jsonl");
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(join(FIXTURES, fixture), dest);
  return dest;
}

function event(type: string, data: Record<string, unknown>, n = 1): Record<string, unknown> {
  return {
    type,
    data,
    id: `00000000-0000-4000-8000-00000000090${n}`,
    timestamp: `2026-01-01T12:00:0${n}.000Z`,
    parentId: null,
  };
}

describe("CopilotProvider parsing", () => {
  it("indexes the prompt as typed and the assistant reply", async () => {
    const meta = await parse("basic-session.jsonl");
    expect(meta).not.toBeNull();
    expect(meta?.provider).toBe("copilot");
    expect(meta?.firstMessage?.text).toBe("How do I reverse a list in Python?");
    expect(meta?.lastMessage?.text).toContain("items[::-1]");
    expect(meta?.lastPrompt).toBe("How do I reverse a list in Python?");
    expect(meta?.messageCount).toBe(2);
    expect(meta?.lastMessageSender).toBe("assistant");
    expect(meta?.sessionName).toBe("How do I reverse a list in Python?");
    expect(meta?.kind).toBe("conversation");
  });

  it("reads session id, project and model from the events", async () => {
    const meta = await parse("basic-session.jsonl");
    expect(meta?.sessionId).toBe(BASIC_ID);
    expect(meta?.externalSessionId).toBe(BASIC_ID);
    expect(meta?.projectPath).toBe("/tmp/example-project");
    expect(meta?.projectName).toBe("tmp/example-project");
    expect(meta?.model).toBe("example-model");
    expect(meta?.timestamp).toBe("2026-01-01T12:00:18.000Z");
  });

  it("does not index the datetime wrapper Copilot adds for the model", async () => {
    const meta = await parse("basic-session.jsonl");
    // Positive control: the wrapper really is in the fixture.
    expect(readFileSync(join(FIXTURES, "basic-session.jsonl"), "utf8")).toContain(
      "<current_datetime>",
    );
    expect(meta?.preview).not.toContain("current_datetime");
    expect(meta?.contentSnippet).not.toContain("current_datetime");
  });

  it("ignores model.* events even though they carry role and content", async () => {
    const raw = readFileSync(join(FIXTURES, "basic-session.jsonl"), "utf8");
    // Positive control: the side-channel text is present, as an assistant role.
    expect(raw).toContain("example side-channel model output");
    expect(raw).toContain('"type":"model.message"');

    const meta = await parse("basic-session.jsonl");
    expect(meta?.messageCount).toBe(2);
    expect(meta?.contentSnippet).not.toContain("side-channel");

    const convo = await parseCopilotConversation(join(FIXTURES, "basic-session.jsonl"), "copilot");
    expect(convo?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(convo?.fullText).not.toContain("side-channel");
  });

  it("collects tool names and does not count a tool-only step as a message", async () => {
    const meta = await parse("session-with-tools.jsonl");
    expect(meta?.toolNames).toEqual(["bash"]);
    expect(meta?.messageCount).toBe(2);
    expect(meta?.lastMessage?.text).toContain("README.md");
  });

  it("emits a tool-only step as a message carrying its tool call", async () => {
    const convo = await parseCopilotConversation(
      join(FIXTURES, "session-with-tools.jsonl"),
      "copilot",
    );
    expect(convo?.messages).toHaveLength(3);
    const step = convo?.messages[1];
    expect(step?.role).toBe("assistant");
    expect(step?.text).toBe("");
    expect(step?.metadata?.toolUseBlocks).toEqual([
      {
        id: "example-toolCallId-10",
        name: "bash",
        input: { command: "ls", description: "List files", mode: "example mode", initial_wait: 1 },
      },
    ]);
    expect(convo?.lastPrompt).toBe("List the files in this directory");
    expect(convo?.sessionId).toBe(TOOLS_ID);
    expect(convo?.projectPath).toBe("/tmp/example-project");
  });

  it("ignores unknown event types, malformed events and bad JSON", async () => {
    const meta = await parse("unknown-events.jsonl");
    expect(meta).not.toBeNull();
    expect(meta?.messageCount).toBe(2);
    expect(meta?.firstMessage?.text).toBe("Does this still parse?");
    expect(meta?.lastMessage?.text).toContain("ignored safely");
    // Positive control: the unknown event's text is in the file.
    expect(readFileSync(join(FIXTURES, "unknown-events.jsonl"), "utf8")).toContain(
      "does not exist yet",
    );
    expect(meta?.contentSnippet).not.toContain("does not exist yet");
  });

  it("returns null for a session with no messages", async () => {
    const provider = new CopilotProvider();
    const acc = provider.createEmptyAccumulator();
    provider.reduceEntry(acc, event("session.start", { sessionId: BASIC_ID }), TIER);
    provider.reduceEntry(acc, event("session.shutdown", { shutdownType: "routine" }, 2), TIER);
    expect(provider.finalize(acc, "/tmp/x/events.jsonl", "copilot", TIER)).toBeNull();
  });

  it("tracks first and last prompts across turns and keeps the git branch", () => {
    const provider = new CopilotProvider();
    const acc = provider.createEmptyAccumulator();
    const entries = [
      event("session.start", {
        sessionId: BASIC_ID,
        context: { cwd: "/tmp/example-project", branch: "main" },
      }),
      event("user.message", { content: "first prompt" }, 2),
      event("assistant.message", { content: "first reply", model: "example-model" }, 3),
      event("user.message", { content: "second prompt" }, 4),
    ];
    for (const e of entries) provider.reduceEntry(acc, e, TIER);
    const meta = provider.finalize(acc, "/tmp/x/events.jsonl", "copilot", TIER);
    expect(meta?.firstMessage?.text).toBe("first prompt");
    expect(meta?.lastPrompt).toBe("second prompt");
    expect(meta?.lastMessage?.text).toBe("first reply");
    expect(meta?.lastMessageSender).toBe("user");
    expect(meta?.gitBranch).toBe("main");
    expect(meta?.messageCount).toBe(3);
  });

  it("falls back to the session directory name when session.start is missing", () => {
    const provider = new CopilotProvider();
    const acc = provider.createEmptyAccumulator();
    provider.reduceEntry(acc, event("user.message", { content: "hello" }), TIER);
    const meta = provider.finalize(acc, `/tmp/state/${TOOLS_ID}/events.jsonl`, "copilot", TIER);
    expect(meta?.sessionId).toBe(TOOLS_ID);
  });

  it("keeps string tool arguments instead of dropping them", () => {
    const message = parseCopilotJsonlLine(
      JSON.stringify(
        event("assistant.message", {
          content: "",
          toolRequests: [{ toolCallId: "call-1", name: "apply_patch", arguments: "raw input" }],
        }),
      ),
    );
    expect(message?.metadata?.toolUseBlocks).toEqual([
      { id: "call-1", name: "apply_patch", input: { arguments: "raw input" } },
    ]);
  });

  it("does not steal Claude, Codex or Cursor files, and they do not steal Copilot", () => {
    const provider = new CopilotProvider();
    const head = (dir: string, file: string) =>
      readFileSync(join(dir, file), "utf8").slice(0, 8192);
    const claude = head(CLAUDE_FIXTURES, "valid-conversation.jsonl");
    const codex = head(CODEX_FIXTURES, "basic-session.jsonl");
    const cursor = head(CURSOR_FIXTURES, "basic-session.jsonl");
    const copilot = head(FIXTURES, "basic-session.jsonl");
    expect(provider.canParse("x.jsonl", copilot)).toBe(true);
    expect(provider.canParse("x.jsonl", claude)).toBe(false);
    expect(provider.canParse("x.jsonl", codex)).toBe(false);
    expect(provider.canParse("x.jsonl", cursor)).toBe(false);
    expect(new ThreadbaseProvider().canParse("x.jsonl", copilot)).toBe(false);
    expect(new CodexCliProvider().canParse("x.jsonl", copilot)).toBe(false);
    expect(new CursorProvider().canParse("x.jsonl", copilot)).toBe(false);
  });

  it("accepts the wire name", () => {
    expect(canonicalizeProviderName("copilot")).toBe("copilot");
  });
});

describe("Copilot line parser and search document", () => {
  const lines = readFileSync(join(FIXTURES, "session-with-tools.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);

  it("maps only user.message and assistant.message lines to messages", () => {
    const mapped = lines.filter((l) => parseCopilotJsonlLine(l) !== null);
    expect(mapped.map((l) => JSON.parse(l).type)).toEqual([
      "user.message",
      "assistant.message",
      "assistant.message",
    ]);
    expect(lines.length).toBeGreaterThan(mapped.length);
  });

  it("uses Copilot's messageId as the message uuid", () => {
    const user = parseCopilotJsonlLine(
      lines.find((l) => l.includes('"type":"user.message"')) ?? "",
    );
    expect(user?.uuid).toBe("00000000-0000-4000-8000-000000000005");
    expect(user?.timestamp).toBe("2026-01-01T12:00:04.000Z");
  });

  it("puts message text and tool arguments in the search document", () => {
    const deltas = lines.map((l) => extractSearchDelta(JSON.parse(l)));
    const text = deltas.map((d) => d.text).join("\n");
    const tools = deltas.map((d) => d.tools).join("\n");
    expect(text).toContain("List the files in this directory");
    expect(text).toContain("README.md and package.json");
    expect(text).not.toContain("side-channel");
    expect(text).not.toContain("current_datetime");
    expect(tools).toContain('"command":"ls"');
  });
});

describe("Copilot fixtures are sanitized", () => {
  it("contain no home path, user name, email or real model name", () => {
    const files = readdirSync(FIXTURES);
    expect(files.length).toBeGreaterThan(0);
    // Positive control: the pattern does match the things it is meant to catch.
    const forbidden =
      /\/Users\/|\/home\/|[A-Za-z]:\\\\|@[a-z0-9-]+\.[a-z]{2,}|gpt-|claude-|ghp_|github_pat_/i;
    for (const sample of ["/Users/someone/x", "/home/someone", "a@example.com", "gpt-5"]) {
      expect(forbidden.test(sample)).toBe(true);
    }
    for (const file of files) {
      const raw = readFileSync(join(FIXTURES, file), "utf8");
      expect(forbidden.test(raw), file).toBe(false);
      // Every path-like value is the neutral placeholder.
      for (const m of raw.matchAll(/"(?:cwd|gitRoot|workingDirectory)":"([^"]*)"/g)) {
        expect(m[1], file).toBe("/tmp/example-project");
      }
      // Every id is a fixed fake: 00000000-0000-4000-8000-xxxxxxxxxxxx.
      for (const m of raw.matchAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      )) {
        expect(m[0].startsWith("00000000-0000-4000-8000-"), `${file}: ${m[0]}`).toBe(true);
      }
    }
  });
});

describe("ConversationScanner with copilot (in-memory)", () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "copilot-mem-"));
    root = join(dir, "session-state");
    plant(root, BASIC_ID, "basic-session.jsonl");
    plant(root, TOOLS_ID, "session-with-tools.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const scan = (opts: Record<string, unknown>) =>
    new ConversationScanner({ persistent: false }).scan({ profiles: [], ...opts });

  it("finds Copilot sessions from copilotRoots", async () => {
    const result = await scan({ providers: ["copilot"], copilotRoots: [root] });
    const convos = result.conversations as ConversationMeta[];
    expect(convos).toHaveLength(2);
    expect(convos.every((c) => c.provider === "copilot")).toBe(true);
  });

  it("accepts the Copilot home as a root too", async () => {
    const result = await scan({ providers: ["copilot"], copilotRoots: [dir] });
    expect(result.conversations as ConversationMeta[]).toHaveLength(2);
  });

  it("indexes nothing without copilotRoots, or without the provider", async () => {
    const noRoots = await scan({ providers: ["copilot"] });
    expect(noRoots.conversations as ConversationMeta[]).toHaveLength(0);
    const notEnabled = await scan({ copilotRoots: [root] });
    expect(notEnabled.conversations as ConversationMeta[]).toHaveLength(0);
  });
});
