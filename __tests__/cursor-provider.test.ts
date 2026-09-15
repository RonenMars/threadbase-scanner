import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliProvider } from "../src/providers/codex-cli";
import { CursorProvider } from "../src/providers/cursor";
import { parseMetaWithProvider } from "../src/providers/parse";
import { ThreadbaseProvider } from "../src/providers/threadbase";
import { ConversationScanner } from "../src/scanner";
import { resolveTier } from "../src/tiers";
import type { ConversationMeta } from "../src/types";

const FIXTURES = join(__dirname, "..", "__fixtures__", "cursor");
const CODEX_FIXTURES = join(__dirname, "..", "__fixtures__", "codex-cli");
const CLAUDE_FIXTURES = join(__dirname, "..", "__fixtures__");
const TIER = resolveTier("standard");

function parse(file: string): Promise<ConversationMeta | null> {
  return parseMetaWithProvider(new CursorProvider(), join(FIXTURES, file), "cursor", TIER);
}

function plant(
  root: string,
  sessionId: string,
  fixture: string,
  slug = "Users-dev-widget",
): string {
  const dest = join(root, slug, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(join(FIXTURES, fixture), dest);
  return dest;
}

describe("CursorProvider parsing", () => {
  it("parses first/last user text and last assistant text without wrapper tags", async () => {
    const meta = await parse("basic-session.jsonl");
    expect(meta).not.toBeNull();
    expect(meta?.provider).toBe("cursor");
    expect(meta?.firstMessage?.text).toBe("How do I reverse a list in Python?");
    expect(meta?.lastMessage?.text).toContain("sort in place");
    expect(meta?.lastPrompt).toBe("And to sort it?");
    expect(meta?.messageCount).toBe(4);
    expect(meta?.sessionName).toBe("How do I reverse a list in Python?");
  });

  it("uses the filename stem as session id", async () => {
    const meta = await parse("basic-session.jsonl");
    expect(meta?.sessionId).toBe("basic-session");
    expect(meta?.externalSessionId).toBe("basic-session");
  });

  it("collects tool names and does not count tool-only lines as messages", async () => {
    const meta = await parse("session-with-tools.jsonl");
    expect(meta?.toolNames).toContain("Grep");
    expect(meta?.toolNames).toContain("Read");
    expect(meta?.messageCount).toBe(2);
    expect(meta?.lastMessage?.text).toContain("Found one TODO");
  });

  it("ignores unknown event shapes and bad JSON safely", async () => {
    const meta = await parse("unknown-events.jsonl");
    expect(meta).not.toBeNull();
    expect(meta?.messageCount).toBe(2);
    expect(meta?.firstMessage?.text).toBe("Does this still parse?");
    expect(meta?.lastMessage?.text).toContain("ignored safely");
  });

  it("does not steal Claude or Codex files", () => {
    const provider = new CursorProvider();
    const claude = readFileSync(join(CLAUDE_FIXTURES, "valid-conversation.jsonl"), "utf8").slice(
      0,
      2048,
    );
    const codex = readFileSync(join(CODEX_FIXTURES, "basic-session.jsonl"), "utf8").slice(0, 2048);
    const cursor = readFileSync(join(FIXTURES, "basic-session.jsonl"), "utf8").slice(0, 2048);
    expect(provider.canParse("x.jsonl", claude)).toBe(false);
    expect(provider.canParse("x.jsonl", codex)).toBe(false);
    expect(provider.canParse("x.jsonl", cursor)).toBe(true);
    expect(new ThreadbaseProvider().canParse("x.jsonl", cursor)).toBe(false);
    expect(new CodexCliProvider().canParse("x.jsonl", cursor)).toBe(false);
  });

  it("claims Claude and Codex envelopes only under agent-transcripts", () => {
    const provider = new CursorProvider();
    const claude = readFileSync(join(FIXTURES, "imported-from-claude.jsonl"), "utf8");
    const codex = readFileSync(join(FIXTURES, "imported-from-codex.jsonl"), "utf8");
    expect(provider.canParse("x.jsonl", claude)).toBe(false);
    expect(provider.canParse("x.jsonl", codex)).toBe(false);
    expect(provider.canParse("/tmp/agent-transcripts/sess.jsonl", claude)).toBe(true);
    expect(provider.canParse("/tmp/agent-transcripts/sess.jsonl", codex)).toBe(true);
  });

  it("marks a Claude-envelope copy under agent-transcripts as imported from Claude", async () => {
    const meta = await parse("imported-from-claude.jsonl");
    expect(meta?.provider).toBe("cursor");
    expect(meta?.isImportedFromClaude).toBe(true);
    expect(meta?.isImportedFromCodex).toBeUndefined();
    expect(meta?.isImportedFromCursor).toBeUndefined();
    expect(meta?.messageCount).toBe(2);
    expect(meta?.firstMessage?.text).toBe("How did this Claude session get here?");
  });

  it("marks a Codex-envelope copy under agent-transcripts as imported from Codex", async () => {
    const meta = await parse("imported-from-codex.jsonl");
    expect(meta?.provider).toBe("cursor");
    expect(meta?.isImportedFromCodex).toBe(true);
    expect(meta?.isImportedFromClaude).toBeUndefined();
    expect(meta?.messageCount).toBe(2);
    expect(meta?.firstMessage?.text).toBe("How did this Codex session get here?");
  });

  it("honours an importedFrom field on a Cursor-shaped line", async () => {
    const meta = await parse("imported-from-claude-field.jsonl");
    expect(meta?.isImportedFromClaude).toBe(true);
    expect(meta?.isImportedFromCodex).toBeUndefined();
    expect(meta?.messageCount).toBe(2);
  });

  it("leaves native Cursor sessions unmarked", async () => {
    const meta = await parse("basic-session.jsonl");
    expect(meta?.isImportedFromClaude).toBeUndefined();
    expect(meta?.isImportedFromCodex).toBeUndefined();
    expect(meta?.isImportedFromCursor).toBeUndefined();
  });
});

describe("Scanner with Cursor provider", () => {
  let cursorRoot: string;

  beforeEach(() => {
    cursorRoot = mkdtempSync(join(tmpdir(), "cursor-root-"));
    plant(cursorRoot, "sess-basic-0001", "basic-session.jsonl");
    plant(cursorRoot, "sess-tools-0002", "session-with-tools.jsonl");
  });

  afterEach(() => {
    rmSync(cursorRoot, { recursive: true, force: true });
  });

  it("discovers and scans cursor files from cursorRoots", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    const result = await scanner.scan({
      profiles: [],
      providers: ["cursor"],
      cursorRoots: [cursorRoot],
    });
    const convos = result.conversations as ConversationMeta[];
    expect(convos).toHaveLength(2);
    expect(convos.every((c) => c.provider === "cursor")).toBe(true);
  });

  it("does not scan cursor unless cursorRoots given", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    const result = await scanner.scan({ profiles: [], providers: ["cursor"] });
    expect((result.conversations as ConversationMeta[]).length).toBe(0);
  });

  it("search finds cursor conversation text and filters by provider", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({ profiles: [], providers: ["cursor"], cursorRoots: [cursorRoot] });

    const hits = await scanner.search("Python", { provider: "cursor" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].meta.provider).toBe("cursor");

    const viaLegacy = await scanner.search("Python", { provider: "cursor-cli" });
    expect(viaLegacy.length).toBe(hits.length);
    expect(viaLegacy[0].meta.provider).toBe("cursor");

    const none = await scanner.search("Python", { provider: "claude-code" });
    expect(none.length).toBe(0);
  });

  it("handles duplicate sessionId without assuming uniqueness", async () => {
    plant(
      cursorRoot,
      "shared-id-9999",
      "multiple-sessions-same-session-id.jsonl",
      "Users-dev-alpha",
    );
    plant(
      cursorRoot,
      "shared-id-9999",
      "multiple-sessions-same-session-id-newer.jsonl",
      "Users-dev-beta",
    );
    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({ profiles: [], providers: ["cursor"], cursorRoots: [cursorRoot] });

    const all = scanner.getConversationsBySessionId("shared-id-9999");
    expect(all).toHaveLength(2);
    const convo = await scanner.getConversation("shared-id-9999");
    expect(convo?.messages.some((m) => m.text.includes("Newer copy"))).toBe(true);
  });

  it("marks subagent files and names the parent", async () => {
    const parent = plant(cursorRoot, "sess-basic-0001", "basic-session.jsonl");
    const child = join(parent, "..", "subagents", "child-aaaa.jsonl");
    mkdirSync(join(child, ".."), { recursive: true });
    cpSync(join(FIXTURES, "subagent.jsonl"), child);

    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({ profiles: [], providers: ["cursor"], cursorRoots: [cursorRoot] });
    const childMeta = scanner.getConversationsBySessionId("child-aaaa")[0];
    expect(childMeta.isSubagent).toBe(true);
    expect(childMeta.parentSessionUuid).toBe("sess-basic-0001");
    expect(childMeta.subagentId).toBe("child-aaaa");
  });

  it("getConversation resolves a cursor file by path and by sessionId", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    await scanner.scan({ profiles: [], providers: ["cursor"], cursorRoots: [cursorRoot] });

    const byPath = await scanner.getConversation(
      join(
        cursorRoot,
        "Users-dev-widget",
        "agent-transcripts",
        "sess-basic-0001",
        "sess-basic-0001.jsonl",
      ),
    );
    expect(byPath).not.toBeNull();
    expect(byPath?.messages[0]?.text).toBe("How do I reverse a list in Python?");

    const bySession = scanner.getConversationsBySessionId("sess-basic-0001");
    expect(bySession).toHaveLength(1);
  });
});
