// These tests cover the in-memory Codex scan path (scanners built with
// `persistent: false`). Codex is also indexed in the SQLite persistent engine —
// see persistent-codex.test.ts for that path.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliProvider } from "../src/providers/codex-cli";
import { parseMetaWithProvider } from "../src/providers/parse";
import { ConversationScanner } from "../src/scanner";
import { resolveTier } from "../src/tiers";
import type { ConversationMeta } from "../src/types";

const FIXTURES = join(__dirname, "..", "__fixtures__", "codex-cli");
const TIER = resolveTier("standard");

function parse(file: string): Promise<ConversationMeta | null> {
  return parseMetaWithProvider(new CodexCliProvider(), join(FIXTURES, file), "codex", TIER);
}

describe("CodexCliProvider parsing", () => {
  it("parses first/last user text and last assistant text", async () => {
    const meta = await parse("basic-session.jsonl");
    expect(meta).not.toBeNull();
    expect(meta?.provider).toBe("codex-cli");
    expect(meta?.firstMessage?.text).toBe("How do I reverse a list in Python?");
    expect(meta?.lastMessage?.text).toContain("sort in place");
    expect(meta?.lastPrompt).toBe("And to sort it?");
    expect(meta?.messageCount).toBe(4);
  });

  it("fills project path, branch, model, and external session id", async () => {
    const meta = await parse("basic-session.jsonl");
    expect(meta?.projectPath).toBe("/Users/dev/projects/widget");
    expect(meta?.gitBranch).toBe("main");
    expect(meta?.model).toBe("gpt-5.5");
    expect(meta?.externalSessionId).toBe("sess-basic-0001");
    expect(meta?.sessionId).toBe("sess-basic-0001");
  });

  it("collects tool names from function/custom tool calls", async () => {
    const meta = await parse("session-with-tools.jsonl");
    expect(meta?.toolNames).toContain("shell");
    expect(meta?.toolNames).toContain("web_search");
    expect(meta?.lastMessage?.text).toContain("Found one TODO");
  });

  it("ignores unknown event shapes and bad JSON safely", async () => {
    const meta = await parse("unknown-events.jsonl");
    expect(meta).not.toBeNull();
    // developer-role boilerplate and non-message items are excluded; only the
    // one user + one assistant message count.
    expect(meta?.messageCount).toBe(2);
    expect(meta?.firstMessage?.text).toBe("Does this still parse?");
    expect(meta?.lastMessage?.text).toContain("ignored safely");
  });

  it("falls back to the file basename when no session_meta id", async () => {
    // unknown-events has a session_meta id, so use a provider directly on an
    // accumulator without one.
    const provider = new CodexCliProvider();
    const acc = provider.createEmptyAccumulator();
    provider.reduceEntry(
      acc,
      {
        type: "response_item",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
      TIER,
    );
    const meta = provider.finalize(acc, "/tmp/rollout-xyz.jsonl", "codex", TIER);
    expect(meta?.sessionId).toBe("rollout-xyz");
    expect(meta?.externalSessionId).toBeUndefined();
  });
});

describe("Scanner with Codex provider", () => {
  let codexRoot: string;

  beforeEach(() => {
    codexRoot = mkdtempSync(join(tmpdir(), "codex-root-"));
    mkdirSync(join(codexRoot, "2026", "06", "18"), { recursive: true });
    cpSync(
      join(FIXTURES, "basic-session.jsonl"),
      join(codexRoot, "2026", "06", "18", "rollout-basic.jsonl"),
    );
    cpSync(
      join(FIXTURES, "session-with-tools.jsonl"),
      join(codexRoot, "2026", "06", "18", "rollout-tools.jsonl"),
    );
  });

  afterEach(() => {
    rmSync(codexRoot, { recursive: true, force: true });
  });

  it("discovers and scans codex files from codexRoots", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    const result = await scanner.scan({
      profiles: [],
      providers: ["codex-cli"],
      codexRoots: [codexRoot],
    });
    const convos = result.conversations as ConversationMeta[];
    expect(convos).toHaveLength(2);
    expect(convos.every((c) => c.provider === "codex-cli")).toBe(true);
  });

  it("does not scan codex unless codexRoots given", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    const result = await scanner.scan({ profiles: [], providers: ["codex-cli"] });
    expect((result.conversations as ConversationMeta[]).length).toBe(0);
  });

  it("search finds codex conversation text and filters by provider", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });

    const hits = await scanner.search("Python", { provider: "codex-cli" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].meta.provider).toBe("codex-cli");

    const none = await scanner.search("Python", { provider: "claude-code" });
    expect(none.length).toBe(0);
  });

  it("handles duplicate sessionId without assuming uniqueness", async () => {
    cpSync(
      join(FIXTURES, "multiple-sessions-same-session-id.jsonl"),
      join(codexRoot, "2026", "06", "18", "rollout-older.jsonl"),
    );
    cpSync(
      join(FIXTURES, "multiple-sessions-same-session-id-newer.jsonl"),
      join(codexRoot, "2026", "06", "18", "rollout-newer.jsonl"),
    );
    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });

    const all = scanner.getConversationsBySessionId("shared-id-9999");
    expect(all).toHaveLength(2);
    // Newest first (deterministic: latest timestamp wins).
    expect(all[0].projectPath).toBe("/Users/dev/projects/beta");

    // getConversation(sessionId) resolves to the newest deterministically.
    const convo = await scanner.getConversation("shared-id-9999");
    expect(convo?.projectPath).toBe("/Users/dev/projects/beta");
  });

  it("dropping one file does not hide another active file with the same sessionId", async () => {
    const older = join(codexRoot, "2026", "06", "18", "rollout-older.jsonl");
    const newer = join(codexRoot, "2026", "06", "18", "rollout-newer.jsonl");
    cpSync(join(FIXTURES, "multiple-sessions-same-session-id.jsonl"), older);
    cpSync(join(FIXTURES, "multiple-sessions-same-session-id-newer.jsonl"), newer);

    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });
    expect(scanner.getConversationsBySessionId("shared-id-9999")).toHaveLength(2);

    // Drop the newer file. refreshFile uses the Threadbase parser in legacy
    // mode, but the file no longer parses as a message → its row is removed.
    rmSync(newer);
    await scanner.refreshFile(newer);

    const remaining = scanner.getConversationsBySessionId("shared-id-9999");
    expect(remaining).toHaveLength(1);
    // The older file is still resolvable — not hidden by the dropped duplicate.
    expect(remaining[0].projectPath).toBe("/Users/dev/projects/alpha");
  });

  it("getConversation resolves a codex file by path and by sessionId", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });

    const byPath = await scanner.getConversation(
      join(codexRoot, "2026", "06", "18", "rollout-basic.jsonl"),
    );
    expect(byPath).not.toBeNull();

    const bySession = scanner.getConversationsBySessionId("sess-basic-0001");
    expect(bySession).toHaveLength(1);
  });
});
