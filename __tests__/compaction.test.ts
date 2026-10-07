import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConversation, parseMeta } from "../src/parser";
import { initialConvState, reduceConvLine } from "../src/persistent/conversation-reducer";
import { buildCheckpoints, readPage } from "../src/persistent/paged-reader";
import { ConversationScanner } from "../src/scanner";
import { extractSearchDelta, isEmptyDelta } from "../src/search-document";
import { DEFAULT_TIERS } from "../src/tiers";
import type { ConversationMessage, Profile } from "../src/types";

// One file with an auto-compaction (mid-task, summary timestamp earlier than
// its boundary) followed by a manual /compact — so it also covers two
// compactions in one conversation.
const FIXTURE = join(__dirname, "..", "__fixtures__", "compaction-conversation.jsonl");
const TOTAL = 13;
const AUTO = { trigger: "auto", preTokens: 266000, postTokens: 28000 };
const MANUAL = { trigger: "manual", preTokens: 120000, postTokens: 9000 };

function expectCompactionMessages(messages: ConversationMessage[]) {
  expect(messages.map((m) => m.uuid)).toEqual([
    "u1",
    "a1",
    "a2",
    "u2",
    "s1",
    "a3",
    "u3",
    "a4",
    "u4",
    "a5",
    "s2",
    "u5",
    "a6",
  ]);
  expect(messages[4]).toMatchObject({ role: "user", isCompactSummary: true, compaction: AUTO });
  expect(messages[10]).toMatchObject({ role: "user", isCompactSummary: true, compaction: MANUAL });
  for (const [i, m] of messages.entries()) {
    if (i === 4 || i === 10) continue;
    expect(m.isCompactSummary).toBeUndefined();
    expect(m.compaction).toBeUndefined();
  }
}

describe("compaction rows", () => {
  it("keeps each summary at its message index, flagged with its boundary", async () => {
    const conv = await parseConversation(FIXTURE, "default");
    expectCompactionMessages(conv?.messages ?? []);
  });

  it("emits the same messages at the same indexes as a file without the flags", () => {
    // What the reducer produced before it knew about compaction: the summary
    // is just another user row. Flagging it must not move anything.
    const entries = readFileSync(FIXTURE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const fold = (rows: Record<string, unknown>[]) => {
      const state = initialConvState();
      return rows.map((r) => reduceConvLine(state, r)?.uuid).filter(Boolean);
    };
    const unflagged = entries.map(({ isCompactSummary: _drop, ...rest }) => rest);
    expect(fold(entries)).toEqual(fold(unflagged));
  });

  it("leaves the summaries out of the message count and previews", async () => {
    const meta = await parseMeta(FIXTURE, "default", DEFAULT_TIERS.standard);
    // 11 text or tool-result rows, minus the two summaries.
    expect(meta?.messageCount).toBe(9);
    expect(meta?.preview).not.toContain("being continued");
    expect(meta?.contentSnippet).not.toContain("being continued");
    expect(meta?.lastMessage?.text).toBe("Here is the final schedule.");
  });

  it("leaves the summaries out of the search document", () => {
    const rows = readFileSync(FIXTURE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const summaries = rows.filter((r) => r.isCompactSummary);
    expect(summaries).toHaveLength(2);
    for (const row of summaries) expect(isEmptyDelta(extractSearchDelta(row))).toBe(true);
  });

  it("flags the summary in a subagent transcript, where the boundary row is isMeta", () => {
    const state = initialConvState();
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      isMeta: true,
      isSidechain: true,
      agentId: "agent-1",
      compactMetadata: { trigger: "auto", preTokens: 500, postTokens: 50 },
    };
    const summary = {
      type: "user",
      uuid: "sub-s1",
      isSidechain: true,
      agentId: "agent-1",
      isCompactSummary: true,
      message: { role: "user", content: "Summary of the subagent's earlier work." },
    };
    expect(reduceConvLine(state, boundary)).toBeNull();
    expect(reduceConvLine(state, summary)).toMatchObject({
      isCompactSummary: true,
      compaction: { trigger: "auto", preTokens: 500, postTokens: 50 },
    });
  });

  it("resumes a page from a checkpoint taken before the boundary", async () => {
    const checkpoints = await buildCheckpoints(FIXTURE, 4);
    const floor = checkpoints.find((c) => c.messageIndex === 4) ?? null;
    expect(floor).not.toBeNull();
    const page = await readPage(FIXTURE, TOTAL, { beforeIndex: 5, limit: 1 }, floor);
    expect(page.fromIndex).toBe(4);
    expect(page.messages[0]).toMatchObject({
      uuid: "s1",
      isCompactSummary: true,
      compaction: AUTO,
    });
  });

  describe("persistent (SQLite) path", () => {
    let dir: string;
    let file: string;
    let profile: Profile;
    let scanner: ConversationScanner;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "compaction-"));
      const pd = join(dir, "projects", "proj");
      mkdirSync(pd, { recursive: true });
      file = join(pd, "sess-compact.jsonl");
      copyFileSync(FIXTURE, file);
      profile = { id: "default", label: "T", configDir: dir, enabled: true };
      scanner = new ConversationScanner({ persistent: { dbPath: join(dir, "i.db") } });
    });
    afterEach(() => {
      scanner.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("pages the same flagged messages and keeps the page total", async () => {
      const result = await scanner.scan({ profiles: [profile] });
      expect(result.conversations.find((c) => c.filePath === file)?.messageCount).toBe(9);

      const page = await scanner.getConversationPage(file, { beforeIndex: TOTAL, limit: 50 });
      expect(page?.total).toBe(TOTAL);
      expect(page?.fromIndex).toBe(0);
      expectCompactionMessages(page?.messages ?? []);

      const one = await scanner.getConversationPage(file, { beforeIndex: 11, limit: 1 });
      expect(one?.fromIndex).toBe(10);
      expect(one?.messages[0]).toMatchObject({ uuid: "s2", compaction: MANUAL });
    });

    it("does not find summary text in search", async () => {
      expect(await scanner.search("lighthouse", { profiles: [profile] })).toHaveLength(1);
      expect(await scanner.search("zebrafish", { profiles: [profile] })).toHaveLength(0);
      expect(await scanner.search("quokka", { profiles: [profile] })).toHaveLength(0);
    });
  });
});
