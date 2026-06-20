import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConversation } from "../src/parser";
import { buildCheckpoints, readPage } from "../src/persistent/paged-reader";
import { ConversationScanner } from "../src/scanner";

// Build a varied conversation: plain text, tool_use lines, tool_result lines
// (which depend on an earlier tool_use to resolve their type), thinking blocks,
// and teammate messages (whose team info is back-applied). These are exactly
// the cross-line dependencies a bounded read must reproduce.
function buildJsonl(n: number): string {
  const lines: string[] = [];
  const ts = (i: number) =>
    `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`;
  for (let i = 0; i < n; i++) {
    if (i % 7 === 0) {
      // assistant tool_use (Edit) — its id is referenced by a later tool_result
      lines.push(
        JSON.stringify({
          type: "assistant",
          uuid: `a${i}`,
          timestamp: ts(i),
          sessionId: "big",
          message: {
            role: "assistant",
            model: "m",
            content: [{ type: "tool_use", id: `tu${i}`, name: "Edit", input: { x: i } }],
          },
        }),
      );
    } else if (i % 7 === 1) {
      // user tool_result referencing the prior tool_use id (type must be "edit")
      lines.push(
        JSON.stringify({
          type: "user",
          uuid: `u${i}`,
          timestamp: ts(i),
          sessionId: "big",
          toolUseResult: { ok: true },
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: `tu${i - 1}`, content: "done", is_error: false },
            ],
          },
        }),
      );
    } else if (i % 11 === 3) {
      // teammate message — team info is collected and back-applied
      lines.push(
        JSON.stringify({
          type: "user",
          uuid: `u${i}`,
          timestamp: ts(i),
          sessionId: "big",
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
        }),
      );
    } else if (i % 5 === 2) {
      // assistant thinking block
      lines.push(
        JSON.stringify({
          type: "assistant",
          uuid: `a${i}`,
          timestamp: ts(i),
          sessionId: "big",
          message: {
            role: "assistant",
            model: "m",
            content: [{ type: "thinking", thinking: `pondering ${i}`, signature: `sig${i}` }],
          },
        }),
      );
    } else {
      lines.push(
        JSON.stringify({
          type: i % 2 === 0 ? "assistant" : "user",
          uuid: `m${i}`,
          timestamp: ts(i),
          sessionId: "big",
          message: {
            role: i % 2 === 0 ? "assistant" : "user",
            content: [{ type: "text", text: `message ${i}` }],
          },
        }),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

describe("bounded paged reader equivalence", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "paged-"));
    file = join(dir, "big.jsonl");
    writeFileSync(file, buildJsonl(120));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readPage matches parseConversation().messages.slice for many windows", async () => {
    const full = await parseConversation(file, "default");
    const all = full?.messages ?? [];
    const total = all.length;
    expect(total).toBeGreaterThan(60);

    // Small interval forces checkpoint use across the file.
    const checkpoints = await buildCheckpoints(file, 10);
    const floor = (idx: number) =>
      [...checkpoints].reverse().find((c) => c.messageIndex <= idx) ?? null;

    const windows: Array<{ beforeIndex?: number; limit: number }> = [
      { limit: 10 },
      { beforeIndex: total, limit: 15 },
      { beforeIndex: 55, limit: 20 },
      { beforeIndex: 33, limit: 33 },
      { beforeIndex: 12, limit: 50 },
      { beforeIndex: 0, limit: 10 },
      { beforeIndex: total, limit: total },
      { beforeIndex: 7, limit: 3 },
      { beforeIndex: 100, limit: 1 },
    ];

    for (const opts of windows) {
      const beforeIndex = opts.beforeIndex ?? total;
      const fromIndex = Math.max(0, beforeIndex - opts.limit);
      const page = await readPage(file, total, opts, floor(fromIndex));
      expect(page.total).toBe(total);
      expect(page.fromIndex).toBe(fromIndex);
      expect(page.messages).toEqual(all.slice(fromIndex, beforeIndex));
    }
  });

  it("works with no checkpoints (reads from the start)", async () => {
    const full = await parseConversation(file, "default");
    const all = full?.messages ?? [];
    const total = all.length;

    const page = await readPage(file, total, { beforeIndex: 40, limit: 20 }, null);
    expect(page.messages).toEqual(all.slice(20, 40));
  });

  it("scanner.getConversationPage builds and uses checkpoints for a large conversation", async () => {
    // >500 messages crosses CHECKPOINT_INTERVAL, so the scanner builds
    // checkpoints lazily on first page request.
    const big = mkdtempSync(join(tmpdir(), "paged-big-"));
    const pd = join(big, "projects", "p");
    mkdirSync(pd, { recursive: true });
    const bigFile = join(pd, "huge.jsonl");
    writeFileSync(bigFile, buildJsonl(600));

    const full = await parseConversation(bigFile, "default");
    const all = full?.messages ?? [];
    const total = all.length;
    expect(total).toBeGreaterThan(500);

    const dbPath = join(big, "i.db");
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ id: "default", label: "T", configDir: big, enabled: true }] });

    // A window near the end must match the full parse exactly.
    const page = await scanner.getConversationPage("big", { beforeIndex: total, limit: 25 });
    expect(page?.total).toBe(total);
    expect(page?.fromIndex).toBe(total - 25);
    expect(page?.messages).toEqual(all.slice(total - 25, total));

    // A second page reuses the checkpoints built on the first call.
    const mid = await scanner.getConversationPage("big", { beforeIndex: 300, limit: 30 });
    expect(mid?.messages).toEqual(all.slice(270, 300));

    scanner.close();
    rmSync(big, { recursive: true, force: true });
  });
});
