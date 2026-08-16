import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";
import { SEARCH_BUDGET } from "../src/search-document";
import type { Profile } from "../src/types";

// One JSONL line per helper, mirroring the real Claude Code shapes the
// extractor has to distinguish.

function line(sid: string, ts: string, body: Record<string, unknown>) {
  return `${JSON.stringify({
    uuid: `${sid}-${ts}`,
    timestamp: ts,
    sessionId: sid,
    slug: sid,
    cwd: "/home/proj",
    ...body,
  })}\n`;
}

const userText = (sid: string, ts: string, text: string) =>
  line(sid, ts, { type: "user", message: { role: "user", content: [{ type: "text", text }] } });

const assistantText = (sid: string, ts: string, text: string) =>
  line(sid, ts, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

const assistantThinking = (sid: string, ts: string, thinking: string, signature: string) =>
  line(sid, ts, {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "thinking", thinking, signature }] },
  });

const toolUse = (sid: string, ts: string, input: unknown) =>
  line(sid, ts, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Read", input }],
    },
  });

const toolResult = (sid: string, ts: string, content: unknown, toolUseResult?: unknown) =>
  line(sid, ts, {
    type: "user",
    toolUseResult,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
  });

describe("persistent search corpus", () => {
  let dir: string;
  let dbPath: string;
  let projectDir: string;
  let profile: Profile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "corpus-"));
    dbPath = join(dir, "i.db");
    projectDir = join(dir, "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    profile = { id: "default", label: "T", configDir: dir, enabled: true };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const scanner = () => new ConversationScanner({ persistent: { dbPath } });
  const write = (name: string, contents: string) => writeFileSync(join(projectDir, name), contents);

  async function search(query: string) {
    const s = scanner();
    try {
      return await s.search(query, { profiles: [profile] });
    } finally {
      s.close();
    }
  }

  // search() only auto-scans when the index is empty, so a test that mutates an
  // already-indexed file has to trigger the rescan itself.
  async function rescanAndSearch(query: string) {
    const s = scanner();
    try {
      await s.scan({ profiles: [profile] });
      return await s.search(query, { profiles: [profile] });
    } finally {
      s.close();
    }
  }

  it("finds a term far past the old 5 KB contentSnippet cutoff", async () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(600); // ~16 KB, well past 5 KB
    write(
      "a.jsonl",
      userText("sa", "2026-01-01T00:00:00.000Z", filler) +
        userText("sa", "2026-01-01T00:01:00.000Z", "DEEPBODYNEEDLE appears late"),
    );

    expect((await search("DEEPBODYNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
  });

  it("finds a term that appears only in assistant text", async () => {
    write("a.jsonl", assistantText("sa", "2026-01-01T00:00:00.000Z", "ASSISTANTNEEDLE here"));
    expect((await search("ASSISTANTNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
  });

  it("finds a term that appears only in thinking, but not the thinking signature", async () => {
    write(
      "a.jsonl",
      userText("sa", "2026-01-01T00:00:00.000Z", "hello") +
        assistantThinking(
          "sa",
          "2026-01-01T00:01:00.000Z",
          "THINKNEEDLE reasoning",
          "SIGNEEDLEblob",
        ),
    );

    expect((await search("THINKNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
    expect(await search("SIGNEEDLEblob")).toHaveLength(0);
  });

  it("finds a term that appears only in tool input", async () => {
    write(
      "a.jsonl",
      userText("sa", "2026-01-01T00:00:00.000Z", "hello") +
        toolUse("sa", "2026-01-01T00:01:00.000Z", { path: "/x/TOOLINPUTNEEDLE.ts" }),
    );
    expect((await search("TOOLINPUTNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
  });

  it("finds a term in a string tool_result", async () => {
    write(
      "a.jsonl",
      userText("sa", "2026-01-01T00:00:00.000Z", "hello") +
        toolResult("sa", "2026-01-01T00:01:00.000Z", "STRINGRESULTNEEDLE in output"),
    );
    expect((await search("STRINGRESULTNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
  });

  it("finds a term in the top-level structured toolUseResult", async () => {
    write(
      "a.jsonl",
      userText("sa", "2026-01-01T00:00:00.000Z", "hello") +
        toolResult("sa", "2026-01-01T00:01:00.000Z", "short", {
          stdout: "STRUCTUREDRESULTNEEDLE from the command",
        }),
    );
    expect((await search("STRUCTUREDRESULTNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
  });

  describe("system-tag wrappers", () => {
    it("does not index a token that appears only inside a system-reminder", async () => {
      write(
        "a.jsonl",
        userText(
          "sa",
          "2026-01-01T00:00:00.000Z",
          "<system-reminder>WRAPPERONLYNEEDLE</system-reminder>the real question",
        ),
      );

      expect(await search("WRAPPERONLYNEEDLE")).toHaveLength(0);
      expect((await search("question")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
    });

    it("does index the same token when it appears in real body text", async () => {
      write("a.jsonl", userText("sa", "2026-01-01T00:00:00.000Z", "WRAPPERONLYNEEDLE matters"));
      expect((await search("WRAPPERONLYNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
    });
  });

  describe("budgets", () => {
    it("keeps the newest text when the window overflows, and drops the oldest", async () => {
      const filler = "x".repeat(SEARCH_BUDGET.textMax);
      write(
        "a.jsonl",
        userText("sa", "2026-01-01T00:00:00.000Z", `OLDESTNEEDLE ${filler}`) +
          userText("sa", "2026-01-01T00:02:00.000Z", "NEWESTNEEDLE at the tail"),
      );

      expect((await search("NEWESTNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
      expect(await search("OLDESTNEEDLE")).toHaveLength(0);
    });

    it("does not let a huge tool payload displace text or thinking", async () => {
      write(
        "a.jsonl",
        userText("sa", "2026-01-01T00:00:00.000Z", "TEXTSURVIVESNEEDLE") +
          assistantThinking("sa", "2026-01-01T00:01:00.000Z", "THINKSURVIVESNEEDLE", "sig") +
          toolResult("sa", "2026-01-01T00:02:00.000Z", "z".repeat(SEARCH_BUDGET.toolsMax * 4)),
      );

      expect((await search("TEXTSURVIVESNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
      expect((await search("THINKSURVIVESNEEDLE")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
    });

    it("caps a single tool payload so its tail cannot be indexed", async () => {
      const payload = `${"q".repeat(SEARCH_BUDGET.toolPayloadMax)}PASTTHECAPNEEDLE`;
      write(
        "a.jsonl",
        userText("sa", "2026-01-01T00:00:00.000Z", "hi") +
          toolResult("sa", "2026-01-01T00:01:00.000Z", payload),
      );

      expect(await search("PASTTHECAPNEEDLE")).toHaveLength(0);
    });
  });

  describe("appends", () => {
    it("puts a newly appended user message into the text bucket", async () => {
      write("a.jsonl", userText("sa", "2026-01-01T00:00:00.000Z", "first message"));

      const first = scanner();
      await first.search("first", { profiles: [profile] });
      first.close();

      appendFileSync(
        join(projectDir, "a.jsonl"),
        toolResult("sa", "2026-01-01T00:01:00.000Z", "tool noise") +
          userText("sa", "2026-01-01T00:02:00.000Z", "APPENDEDNEEDLE after tools"),
      );

      const hits = await rescanAndSearch("APPENDEDNEEDLE");
      expect(hits.map((h) => h.meta.sessionId)).toEqual(["sa"]);
      // Still a body hit with a real excerpt, not a preview fallback.
      expect(hits[0].matches[0].field).toBe("content");
      expect(hits[0].matches[0].snippet).toContain("APPENDEDNEEDLE");
    });

    it("keeps earlier content searchable after an append", async () => {
      write("a.jsonl", userText("sa", "2026-01-01T00:00:00.000Z", "ORIGINALNEEDLE"));
      const first = scanner();
      await first.search("ORIGINALNEEDLE", { profiles: [profile] });
      first.close();

      appendFileSync(
        join(projectDir, "a.jsonl"),
        userText("sa", "2026-01-01T00:01:00.000Z", "second"),
      );

      expect((await rescanAndSearch("ORIGINALNEEDLE")).map((h) => h.meta.sessionId)).toEqual([
        "sa",
      ]);
    });
  });

  describe("lifecycle", () => {
    it("drops corpus from a replaced file", async () => {
      write("a.jsonl", userText("sa", "2026-01-01T00:00:00.000Z", "BEFOREREPLACENEEDLE"));
      const first = scanner();
      await first.search("BEFOREREPLACENEEDLE", { profiles: [profile] });
      first.close();

      // Shorter content -> classify() sees truncation and reindexes from 0.
      write("a.jsonl", userText("sa", "2026-02-01T00:00:00.000Z", "AFTER"));

      expect(await rescanAndSearch("BEFOREREPLACENEEDLE")).toHaveLength(0);
      expect((await search("AFTER")).map((h) => h.meta.sessionId)).toEqual(["sa"]);
    });

    it("drops corpus from a deleted file", async () => {
      write("a.jsonl", userText("sa", "2026-01-01T00:00:00.000Z", "DELETEDNEEDLE"));
      write("b.jsonl", userText("sb", "2026-01-01T00:00:00.000Z", "kept"));
      const first = scanner();
      await first.search("DELETEDNEEDLE", { profiles: [profile] });
      first.close();

      rmSync(join(projectDir, "a.jsonl"));
      const s = scanner();
      await s.scan({ profiles: [profile], fullRescan: true });
      const hits = await s.search("DELETEDNEEDLE", { profiles: [profile] });
      s.close();

      expect(hits).toHaveLength(0);
    });
  });

  describe("snippets and match fields", () => {
    it("returns a content field, an excerpt and highlight ranges for a body hit", async () => {
      write(
        "a.jsonl",
        userText(
          "sa",
          "2026-01-01T00:00:00.000Z",
          "the socket reconnect HIGHLIGHTNEEDLE was not cleared after close",
        ),
      );

      const [hit] = await search("HIGHLIGHTNEEDLE");
      const match = hit.matches[0];

      const highlights = match.highlights ?? [];
      expect(match.field).toBe("content");
      expect(match.snippet).toContain("HIGHLIGHTNEEDLE");
      expect(highlights.length).toBeGreaterThanOrEqual(1);

      const { start, end } = highlights[0];
      expect(match.snippet.slice(start, end).toLowerCase()).toContain("highlightneedle");
    });

    it("does not fall back to an unrelated preview for a deep body hit", async () => {
      const filler = "unrelated preamble text ".repeat(500);
      write(
        "a.jsonl",
        userText("sa", "2026-01-01T00:00:00.000Z", filler) +
          userText("sa", "2026-01-01T00:01:00.000Z", "NOTPREVIEWNEEDLE deep in the body"),
      );

      const [hit] = await search("NOTPREVIEWNEEDLE");
      expect(hit.matches[0].field).not.toBe("preview");
      expect(hit.matches[0].snippet).toContain("NOTPREVIEWNEEDLE");
    });

    it("uses camelCase metadata field names, never FTS column names", async () => {
      write("a.jsonl", userText("METAFIELDNEEDLE", "2026-01-01T00:00:00.000Z", "body"));

      const [hit] = await search("METAFIELDNEEDLE");
      const fields = hit.matches.map((m) => m.field);

      expect(fields).not.toContain("session_name");
      expect(fields).not.toContain("tool_names");
      expect(fields).not.toContain("contentSnippet");
      expect(fields.some((f) => ["sessionName", "sessionId", "content"].includes(f))).toBe(true);
    });
  });
});
