import * as fs from "fs";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { monitorEventLoopDelay } from "perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJsonlParseState, parseJsonlLine } from "../src/index";
import * as parserModule from "../src/parser";
import { parseConversation } from "../src/parser";
import * as conversationStreamModule from "../src/persistent/conversation-stream";
import { openDatabase } from "../src/persistent/db";
import * as tailReaderModule from "../src/persistent/jsonl-tail-reader";
import * as pagedReaderModule from "../src/persistent/paged-reader";
import { ConversationScanner } from "../src/scanner";

// Deterministic line generator keyed on the ABSOLUTE message index, so a file
// built as lines(0..n) and later extended with lines(n..m) is byte-identical to
// one written as lines(0..m) in a single shot. Mirrors the paged-reader fixture
// variety: tool_use → tool_result cross-line pairs, teammate messages, thinking
// blocks, and plain text — every shape produces exactly one page message.
function lineFor(i: number): string {
  const ts = `2026-01-01T${String(Math.floor(i / 3600) % 24).padStart(2, "0")}:${String(
    Math.floor(i / 60) % 60,
  ).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;
  if (i % 7 === 0) {
    return JSON.stringify({
      type: "assistant",
      uuid: `a${i}`,
      timestamp: ts,
      sessionId: "sess-live",
      cwd: "/home/live",
      message: {
        role: "assistant",
        model: "m",
        content: [{ type: "tool_use", id: `tu${i}`, name: "Edit", input: { x: i } }],
      },
    });
  }
  if (i % 7 === 1) {
    return JSON.stringify({
      type: "user",
      uuid: `u${i}`,
      timestamp: ts,
      sessionId: "sess-live",
      toolUseResult: { ok: true },
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `tu${i - 1}`, content: "done", is_error: false },
        ],
      },
    });
  }
  if (i % 11 === 3) {
    return JSON.stringify({
      type: "user",
      uuid: `u${i}`,
      timestamp: ts,
      sessionId: "sess-live",
      teamName: "alpha",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: `<teammate-message teammate_id="t1" summary="s" color="red">hi ${i}</teammate-message>`,
          },
        ],
      },
    });
  }
  if (i % 5 === 2) {
    return JSON.stringify({
      type: "assistant",
      uuid: `a${i}`,
      timestamp: ts,
      sessionId: "sess-live",
      message: {
        role: "assistant",
        model: "m",
        content: [{ type: "thinking", thinking: `pondering ${i}`, signature: `sig${i}` }],
      },
    });
  }
  return JSON.stringify({
    type: i % 2 === 0 ? "assistant" : "user",
    uuid: `m${i}`,
    timestamp: ts,
    sessionId: "sess-live",
    message: {
      role: i % 2 === 0 ? "assistant" : "user",
      content: [{ type: "text", text: `message ${i}` }],
    },
  });
}

function linesFor(start: number, count: number): string {
  const lines: string[] = [];
  for (let i = start; i < start + count; i++) lines.push(lineFor(i));
  return `${lines.join("\n")}\n`;
}

function checkpointRows(dbPath: string, filePath: string) {
  const db = openDatabase(dbPath);
  const rows = db
    .prepare(
      `SELECT id, message_index, byte_offset FROM message_checkpoints
       WHERE source_path = ? ORDER BY message_index`,
    )
    .all(filePath) as { id: number; message_index: number; byte_offset: number }[];
  db.close();
  return rows;
}

describe("incremental refresh (byte-offset checkpointing)", () => {
  let dir: string;
  let file: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "incref-"));
    fs.mkdirSync(join(dir, "projects", "p"), { recursive: true });
    file = join(dir, "projects", "p", "live.jsonl");
    dbPath = join(dir, "i.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = () => ({ id: "default", label: "T", configDir: dir, enabled: true });

  async function seedIndexedFile(n: number): Promise<ConversationScanner> {
    writeFileSync(file, linesFor(0, n));
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    return scanner;
  }

  describe("append-only checkpoints", () => {
    it("refreshFile on append leaves existing checkpoints untouched", async () => {
      const scanner = await seedIndexedFile(1100);
      // First page request builds checkpoints lazily. (Not every fixture line
      // produces a page message — teammate-tag-only lines clean to empty — so
      // totals are asserted against a full parse, not the line count.)
      const page1 = await scanner.getConversationPage(file, { limit: 50 });
      expect(page1?.total).toBeGreaterThan(1000);
      const before = checkpointRows(dbPath, file);
      expect(before.map((r) => r.message_index)).toEqual([500, 1000]);

      fs.appendFileSync(file, linesFor(1100, 4));
      const meta = await scanner.refreshFile(file);
      expect(meta).toBeTruthy();

      // Same rowids, same offsets: the prefix-valid checkpoints survived the append.
      expect(checkpointRows(dbPath, file)).toEqual(before);
      await scanner.close();
    });

    it("getPage after a small append reuses checkpoints without any rebuild", async () => {
      const scanner = await seedIndexedFile(1100);
      await scanner.getConversationPage(file, { limit: 50 });
      fs.appendFileSync(file, linesFor(1100, 4));
      await scanner.refreshFile(file);

      const buildSpy = vi.spyOn(pagedReaderModule, "buildCheckpoints");
      const page = await scanner.getConversationPage(file, { limit: 50 });
      expect(buildSpy).not.toHaveBeenCalled();
      buildSpy.mockRestore();

      // The window spans the appended boundary and equals a full-parse slice.
      const full = await parseConversation(file, "default");
      const total = full?.messages.length ?? 0;
      expect(page?.total).toBe(total);
      expect(page?.messages).toEqual(full?.messages.slice(total - 50));
      await scanner.close();
    });

    it("getPage extends the checkpoint chain past the previous EOF instead of rebuilding from zero", async () => {
      const scanner = await seedIndexedFile(600);
      await scanner.getConversationPage(file, { limit: 10 });
      const before = checkpointRows(dbPath, file);
      expect(before.map((r) => r.message_index)).toEqual([500]);

      fs.appendFileSync(file, linesFor(600, 600));
      await scanner.refreshFile(file);

      const buildSpy = vi.spyOn(pagedReaderModule, "buildCheckpoints");
      const page = await scanner.getConversationPage(file, { limit: 10 });
      expect(buildSpy).toHaveBeenCalledTimes(1);
      // Extension resumes from the last persisted checkpoint, not byte 0.
      const fromArg = buildSpy.mock.calls[0][2];
      expect(fromArg).toBeTruthy();
      expect(fromArg?.byteOffset).toBeGreaterThan(0);
      buildSpy.mockRestore();

      const after = checkpointRows(dbPath, file);
      // The original row survives verbatim (same rowid) and the chain grew.
      expect(after).toEqual(expect.arrayContaining(before));
      expect(after.map((r) => r.message_index)).toEqual([500, 1000]);

      const full = await parseConversation(file, "default");
      const total = full?.messages.length ?? 0;
      expect(page?.total).toBe(total);
      expect(page?.messages).toEqual(full?.messages.slice(total - 10));
      await scanner.close();
    });

    it("truncation drops checkpoints and pages correctly via the full-reparse fallback", async () => {
      const scanner = await seedIndexedFile(1100);
      await scanner.getConversationPage(file, { limit: 50 });
      expect(checkpointRows(dbPath, file).length).toBeGreaterThan(0);

      // Replace with much shorter content (size < cursor → truncation rule).
      writeFileSync(file, linesFor(0, 3));
      await scanner.refreshFile(file);
      expect(checkpointRows(dbPath, file)).toEqual([]);

      const page = await scanner.getConversationPage(file, { limit: 10 });
      const full = await parseConversation(file, "default");
      expect(page?.total).toBe(3);
      expect(page?.messages).toEqual(full?.messages);
      await scanner.close();
    });
  });

  describe("resumable conversation LRU", () => {
    // Spies covering every code path that reads a conversation file in
    // getConversation(); a pure cache hit calls none of them.
    function parseSpies() {
      return {
        full: vi.spyOn(parserModule, "parseConversation"),
        resumable: vi.spyOn(conversationStreamModule, "parseConversationResumable"),
      };
    }

    it("serves the appended messages from the LRU without re-streaming the file", async () => {
      const scanner = await seedIndexedFile(10);
      const conv1 = await scanner.getConversation(file);
      expect(conv1?.messages.length).toBeGreaterThan(0);

      fs.appendFileSync(file, linesFor(10, 3));
      await scanner.refreshFile(file);

      const spies = parseSpies();
      const conv2 = await scanner.getConversation(file);
      expect(spies.full).not.toHaveBeenCalled();
      expect(spies.resumable).not.toHaveBeenCalled();
      spies.full.mockRestore();
      spies.resumable.mockRestore();

      // Extended in place — and byte-identical to a full re-parse.
      const full = await parseConversation(file, "default");
      expect(conv2).toEqual(full);
      expect(conv2?.messages.length).toBeGreaterThan(conv1?.messages.length ?? 0);
      await scanner.close();
    });

    it("extends a conversation cached under its sessionId key too", async () => {
      const scanner = await seedIndexedFile(8);
      const conv1 = await scanner.getConversation("sess-live");
      expect(conv1).toBeTruthy();

      fs.appendFileSync(file, linesFor(8, 2));
      await scanner.refreshFile(file);

      const spies = parseSpies();
      const conv2 = await scanner.getConversation("sess-live");
      expect(spies.full).not.toHaveBeenCalled();
      expect(spies.resumable).not.toHaveBeenCalled();
      spies.full.mockRestore();
      spies.resumable.mockRestore();

      expect(conv2).toEqual(await parseConversation(file, "default"));
      await scanner.close();
    });

    it("keeps the cache warm across a no-op refresh (unchanged file)", async () => {
      const scanner = await seedIndexedFile(6);
      await scanner.getConversation(file);

      await scanner.refreshFile(file);

      const spies = parseSpies();
      const conv = await scanner.getConversation(file);
      expect(spies.full).not.toHaveBeenCalled();
      expect(spies.resumable).not.toHaveBeenCalled();
      spies.full.mockRestore();
      spies.resumable.mockRestore();
      expect(conv?.messages.length).toBeGreaterThan(0);
      await scanner.close();
    });

    it("carries turn_duration and header semantics across the incremental boundary", async () => {
      // turn_duration entries are consumed BEFORE the message reducer in a full
      // parse (their timestamps never advance the conversation timestamp). Give
      // the appended one the latest timestamp in the file so any drift in the
      // incremental fold shows up as a timestamp mismatch.
      const td = (ms: number, ts: string) =>
        JSON.stringify({
          type: "system",
          subtype: "turn_duration",
          durationMs: ms,
          messageCount: 2,
          uuid: `td${ms}`,
          timestamp: ts,
        });
      writeFileSync(file, `${lineFor(4)}\n${td(111, "2026-01-01T00:00:10.000Z")}\n${lineFor(5)}\n`);
      const scanner = new ConversationScanner({ persistent: { dbPath } });
      await scanner.scan({ profiles: [profile()] });
      await scanner.getConversation(file);

      fs.appendFileSync(file, `${lineFor(6)}\n${td(222, "2029-12-31T23:59:59.000Z")}\n`);
      await scanner.refreshFile(file);

      const conv = await scanner.getConversation(file);
      expect(conv).toEqual(await parseConversation(file, "default"));
      expect(conv?.turnDurations?.map((t) => t.durationMs)).toEqual([111, 222]);
      await scanner.close();
    });

    it("does not surface a torn (partial) trailing line until it completes, and never duplicates it", async () => {
      const scanner = await seedIndexedFile(4);
      const conv1 = await scanner.getConversation(file);
      const baseCount = conv1?.messages.length ?? 0;

      // Torn write: a line with no trailing newline.
      fs.appendFileSync(file, lineFor(4));
      await scanner.refreshFile(file);
      const convTorn = await scanner.getConversation(file);
      expect(convTorn?.messages.length).toBe(baseCount);

      // Complete the line: it appears exactly once.
      fs.appendFileSync(file, "\n");
      await scanner.refreshFile(file);
      const convDone = await scanner.getConversation(file);
      expect(convDone).toEqual(await parseConversation(file, "default"));
      expect(convDone?.messages.length).toBe(baseCount + 1);
      await scanner.close();
    });

    it("keeps duplicate-requestId streaming entries identical to a full parse across the boundary", async () => {
      const asstReq = (ts: string, text: string, tokens: number) =>
        JSON.stringify({
          type: "assistant",
          uuid: `a-${ts}`,
          timestamp: ts,
          sessionId: "sess-live",
          cwd: "/home/live",
          requestId: "req_dup",
          message: {
            role: "assistant",
            model: "m",
            content: [{ type: "text", text }],
            usage: { input_tokens: 10, output_tokens: tokens },
          },
        });
      writeFileSync(file, `${asstReq("2026-01-01T00:00:00.000Z", "partial chunk", 5)}\n`);
      const scanner = new ConversationScanner({ persistent: { dbPath } });
      await scanner.scan({ profiles: [profile()] });
      await scanner.getConversation(file);

      // The same requestId arrives again in a LATER incremental batch (token
      // counts grown) — the streamed result must equal a full parse.
      fs.appendFileSync(
        file,
        `${asstReq("2026-01-01T00:00:01.000Z", "partial chunk plus more", 9)}\n`,
      );
      await scanner.refreshFile(file);

      const conv = await scanner.getConversation(file);
      const full = await parseConversation(file, "default");
      expect(conv).toEqual(full);
      expect(conv?.messages.map((m) => m.requestId)).toEqual(["req_dup", "req_dup"]);
      await scanner.close();
    });

    it("evicts the cached conversation on truncation and serves the new content", async () => {
      const scanner = await seedIndexedFile(9);
      await scanner.getConversation(file);

      writeFileSync(file, linesFor(0, 2));
      await scanner.refreshFile(file);

      const conv = await scanner.getConversation(file);
      expect(conv).toEqual(await parseConversation(file, "default"));
      expect(conv?.messages.length).toBe(2);
      await scanner.close();
    });

    it("evicts the cached conversation when the file is replaced by a different one", async () => {
      const scanner = await seedIndexedFile(4);
      const conv1 = await scanner.getConversation(file);
      expect(conv1?.sessionId).toBe("sess-live");

      const replacement = [
        JSON.stringify({
          type: "user",
          uuid: "u-new",
          timestamp: "2026-06-01T00:00:00.000Z",
          sessionId: "sess-NEW",
          cwd: "/home/new",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "a completely different conversation, much longer than before",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a-new",
          timestamp: "2026-06-01T00:00:01.000Z",
          sessionId: "sess-NEW",
          message: {
            role: "assistant",
            model: "m",
            content: [
              {
                type: "text",
                text: "an equally different reply padding the file well past the old size",
              },
            ],
          },
        }),
      ].join("\n");
      writeFileSync(file, `${replacement}\n`);
      await scanner.refreshFile(file);

      const conv2 = await scanner.getConversation(file);
      expect(conv2?.sessionId).toBe("sess-NEW");
      expect(conv2).toEqual(await parseConversation(file, "default"));
      await scanner.close();
    });

    it("drops the cached conversation when the file vanishes", async () => {
      const scanner = await seedIndexedFile(4);
      const conv1 = await scanner.getConversation(file);
      expect(conv1).toBeTruthy();

      rmSync(file);
      const meta = await scanner.refreshFile(file);
      expect(meta).toBeNull();
      expect(await scanner.getConversation(file)).toBeNull();
      await scanner.close();
    });
  });

  describe("event-loop hygiene", () => {
    // retry: event-loop latency also absorbs host scheduler noise when the
    // suite runs files in parallel; a genuine regression (sustained ≥600ms
    // stalls, see below) fails every attempt, while a contended-host blip
    // passes on a calmer retry.
    it("indexes and checkpoints a 100k-line file without long event-loop stalls", { timeout: 120_000, retry: 2 }, async () => {
      // Write the fixture in bounded chunks (and let a macrotask pass) so the
      // histogram below measures the scanner's stalls, not V8 collecting the
      // test's own fixture garbage.
      const lineCount = 100_000;
      const fd = fs.openSync(file, "w");
      for (let i = 0; i < lineCount; i += 5000) {
        const batch: string[] = [];
        for (let j = i; j < Math.min(i + 5000, lineCount); j++) batch.push(lineFor(j));
        fs.writeSync(fd, `${batch.join("\n")}\n`);
      }
      fs.closeSync(fd);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const scanner = new ConversationScanner({ persistent: { dbPath } });
      // Open the SQLite handle + run migrations before measuring: one-time
      // native setup isn't the per-file indexing cost this bound protects.
      await scanner.scan({ profiles: [] });

      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      // Cold index: full metadata fold from byte 0.
      const meta = await scanner.refreshFile(file);
      // Checkpoint build + page read (the historical worst offender).
      const page = await scanner.getConversationPage(file, { limit: 50 });
      histogram.disable();
      await scanner.close();

      expect(meta).toBeTruthy();
      expect(page?.messages).toHaveLength(50);
      // Before the fix this run showed SUSTAINED stalls (max ≈ 740–1000ms,
      // wall ≈ 30s). p99 is the sustained-stall detector at the ~50ms target;
      // the max bound is a catastrophic-block guard set above the one-off
      // scheduler/GC hiccups (~50–150ms) a busy host injects into any process.
      expect(histogram.percentile(99) / 1e6).toBeLessThan(50);
      expect(histogram.max / 1e6).toBeLessThan(500);
    });
  });

  describe("parseJsonlLine export", () => {
    it("maps a message line to the same ConversationMessage the scanner produces", async () => {
      writeFileSync(file, linesFor(4, 3));
      const full = await parseConversation(file, "default");

      const state = createJsonlParseState();
      const parsed = [lineFor(4), lineFor(5), lineFor(6)]
        .map((line) => parseJsonlLine(line, state))
        .filter((m) => m !== null);
      expect(parsed).toEqual(full?.messages);
    });

    it("returns null for lines that produce no message", () => {
      expect(parseJsonlLine("")).toBeNull();
      expect(parseJsonlLine("   ")).toBeNull();
      expect(parseJsonlLine("{not json")).toBeNull();
      expect(
        parseJsonlLine(JSON.stringify({ type: "summary", summary: "s", leafUuid: "x" })),
      ).toBeNull();
      expect(
        parseJsonlLine(JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 5 })),
      ).toBeNull();
      expect(
        parseJsonlLine(JSON.stringify({ type: "file-history-snapshot", messageId: "m" })),
      ).toBeNull();
    });

    it("is stateless for classification but resolves cross-line references with shared state", () => {
      const toolUse = lineFor(0); // assistant tool_use (Edit, id tu0)
      const toolResult = lineFor(1); // user tool_result referencing tu0

      // Stateless: each line classifies independently — the tool_result still
      // produces a message, just without the tool type resolved.
      const alone = parseJsonlLine(toolResult);
      expect(alone?.isToolResult).toBe(true);
      expect(alone?.metadata?.toolResults?.[0]?.type).toBe("generic");

      // Shared state across lines resolves the tool_use → tool_result link,
      // exactly like a full parse.
      const state = createJsonlParseState();
      parseJsonlLine(toolUse, state);
      const linked = parseJsonlLine(toolResult, state);
      expect(linked?.metadata?.toolResults?.[0]?.type).toBe("edit");
    });
  });

  describe("single-flight", () => {
    it("concurrent refreshFile calls on one path coalesce into exactly one parse", async () => {
      const scanner = await seedIndexedFile(6);
      fs.appendFileSync(file, linesFor(6, 2));

      const spy = vi.spyOn(tailReaderModule, "tailReduce");
      const results = await Promise.all(
        Array.from({ length: 10 }, () => scanner.refreshFile(file)),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();

      for (const meta of results) {
        expect(meta?.messageCount).toBe(results[0]?.messageCount);
      }
      await scanner.close();
    });

    it("concurrent getPage calls build checkpoints exactly once", async () => {
      const scanner = await seedIndexedFile(1100);

      const spy = vi.spyOn(pagedReaderModule, "buildCheckpoints");
      const pages = await Promise.all(
        Array.from({ length: 10 }, () => scanner.getConversationPage(file, { limit: 20 })),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();

      for (const page of pages) {
        expect(page?.total).toBeGreaterThan(1000);
        expect(page?.messages).toHaveLength(20);
        expect(page?.messages).toEqual(pages[0]?.messages);
      }
      await scanner.close();
    });
  });
});
