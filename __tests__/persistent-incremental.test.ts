import * as fs from "fs";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMeta } from "../src/parser";
import { openDatabase } from "../src/persistent/db";
import * as tailReaderModule from "../src/persistent/jsonl-tail-reader";
import { ConversationFilesRepo } from "../src/persistent/repositories/conversation-files.repo";
import { ConversationScanner } from "../src/scanner";
import { resolveTier } from "../src/tiers";
import type { ConversationMeta } from "../src/types";

// Read the persisted cursor for a file directly from the DB.
function cursorOf(dbPath: string, filePath: string) {
  const db = openDatabase(dbPath);
  const row = new ConversationFilesRepo(db).getByPath(filePath);
  db.close();
  return row;
}

function user(ts: string, text: string) {
  return JSON.stringify({
    type: "user",
    uuid: `u-${ts}`,
    timestamp: ts,
    sessionId: "sess-inc",
    slug: "inc",
    cwd: "/home/inc",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}
function asst(ts: string, text: string) {
  return JSON.stringify({
    type: "assistant",
    uuid: `a-${ts}`,
    timestamp: ts,
    sessionId: "sess-inc",
    message: { role: "assistant", model: "m", content: [{ type: "text", text }] },
  });
}

describe("incremental byte-offset indexing", () => {
  let dir: string;
  let file: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inc-"));
    fs.mkdirSync(join(dir, "projects", "p"), { recursive: true });
    file = join(dir, "projects", "p", "c.jsonl");
    dbPath = join(dir, "i.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = () => ({ id: "default", label: "T", configDir: "", enabled: true });

  it("advances the cursor to EOF and resumes from there on append", async () => {
    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "first")}\n${asst("2026-01-01T00:00:01.000Z", "reply")}\n`,
    );
    const sizeAfterFirst = statSync(file).size;

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profile(), configDir: dir }] });
    scanner.close();

    // After the first index the cursor sits at EOF, with reducer state persisted
    // so the next pass can resume instead of re-reading from 0.
    const c1 = cursorOf(dbPath, file);
    expect(c1?.last_indexed_offset).toBe(sizeAfterFirst);
    expect(c1?.reducer_state).toBeTruthy();

    // Append two more lines; refresh should advance the cursor to the new EOF.
    fs.appendFileSync(
      file,
      `${user("2026-01-02T00:00:00.000Z", "second")}\n${asst("2026-01-02T00:00:01.000Z", "reply2")}\n`,
    );
    const sizeAfterSecond = statSync(file).size;

    const s2 = new ConversationScanner({ persistent: { dbPath } });
    const meta = await s2.refreshFile(file);
    s2.close();

    expect(meta?.messageCount).toBe(4);
    const c2 = cursorOf(dbPath, file);
    expect(c2?.last_indexed_offset).toBe(sizeAfterSecond);
    expect(c2?.last_indexed_line).toBe(4);
  });

  it("incremental result equals a full re-parse", async () => {
    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "alpha")}\n${asst("2026-01-01T00:00:01.000Z", "beta")}\n`,
    );
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profile(), configDir: dir }] });

    fs.appendFileSync(
      file,
      `${user("2026-01-03T00:00:00.000Z", "gamma with more text")}\n${asst("2026-01-03T00:00:01.000Z", "delta")}\n`,
    );
    const incremental = await scanner.refreshFile(file);

    const full = await parseMeta(file, "default", resolveTier("standard"));
    // gitBranch differs (engine resolves it); compare the rest.
    expect({ ...incremental, gitBranch: null }).toEqual(full);
    scanner.close();
  });

  it("reindexes from zero when the file is truncated", async () => {
    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "one")}\n${asst("2026-01-01T00:00:01.000Z", "two")}\n${user("2026-01-01T00:00:02.000Z", "three")}\n`,
    );
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profile(), configDir: dir }] });

    // Replace with shorter content (truncation): smaller than the old cursor.
    writeFileSync(file, `${user("2026-02-01T00:00:00.000Z", "fresh start")}\n`);
    const newSize = statSync(file).size;

    const meta = await scanner.refreshFile(file);

    // A full reindex re-folds the file: the count reflects ONLY the new content,
    // and the cursor lands at the new (smaller) EOF — not the old larger offset.
    expect(meta?.messageCount).toBe(1);
    expect(meta?.preview).toContain("fresh start");
    const c = cursorOf(dbPath, file);
    expect(c?.last_indexed_offset).toBe(newSize);
    scanner.close();
  });

  it("does not advance the cursor past a trailing partial line", async () => {
    // A line without a trailing newline is a writer mid-append; it must not be
    // parsed or committed until completed.
    writeFileSync(file, `${user("2026-01-01T00:00:00.000Z", "complete")}\n`);
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profile(), configDir: dir }] });
    expect((await scanner.getConversation("sess-inc"))?.messageCount).toBe(1);

    // Append a partial (no newline) line.
    fs.appendFileSync(file, user("2026-01-02T00:00:00.000Z", "partial"));
    const partialMeta = await scanner.refreshFile(file);
    // The partial line is not counted yet.
    expect(partialMeta?.messageCount).toBe(1);

    // Complete the line; now it should be picked up.
    fs.appendFileSync(file, "\n");
    const completeMeta = await scanner.refreshFile(file);
    expect(completeMeta?.messageCount).toBe(2);
    scanner.close();
  });

  it("refreshFile() resumes from the cursor on append instead of reparsing from 0", async () => {
    // Stage 2: refreshFile() used to force=true unconditionally, so the
    // watcher's live-append path re-read the whole file from byte 0 on every
    // debounced tick. Now it passes force=false and lets classify() decide —
    // spy on tailReduce to prove an append resumes from the persisted offset
    // rather than starting over at 0.
    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "first")}\n${asst("2026-01-01T00:00:01.000Z", "reply")}\n`,
    );
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profile(), configDir: dir }] });
    const offsetAfterFirst = cursorOf(dbPath, file)?.last_indexed_offset ?? 0;
    expect(offsetAfterFirst).toBeGreaterThan(0);

    fs.appendFileSync(
      file,
      `${user("2026-01-02T00:00:00.000Z", "second")}\n${asst("2026-01-02T00:00:01.000Z", "reply2")}\n`,
    );

    const tailReduceSpy = vi.spyOn(tailReaderModule, "tailReduce");
    const meta = await scanner.refreshFile(file);
    scanner.close();

    // Called with the PRIOR offset, not 0 — proof the fold resumed rather than
    // re-reading the whole file.
    expect(tailReduceSpy).toHaveBeenCalledWith(
      file,
      offsetAfterFirst,
      expect.any(Number),
      expect.anything(),
      expect.anything(),
    );
    expect(meta?.messageCount).toBe(4);
    tailReduceSpy.mockRestore();
  });

  it("refreshFile() still reindexes from 0 on truncate/replace", async () => {
    // Guard against under-correcting: force=false must not turn a genuine
    // truncate/replace into a bad append — classify() should still say
    // "reindex" and tailReduce should still be called from offset 0.
    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "one")}\n${asst("2026-01-01T00:00:01.000Z", "two")}\n${user("2026-01-01T00:00:02.000Z", "three")}\n`,
    );
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profile(), configDir: dir }] });

    // Replace with shorter content (truncation).
    writeFileSync(file, `${user("2026-02-01T00:00:00.000Z", "fresh start")}\n`);

    const tailReduceSpy = vi.spyOn(tailReaderModule, "tailReduce");
    const meta = await scanner.refreshFile(file);
    scanner.close();

    expect(tailReduceSpy).toHaveBeenCalledWith(file, 0, 0, expect.anything(), expect.anything());
    expect(meta?.messageCount).toBe(1);
    expect(meta?.preview).toContain("fresh start");
    tailReduceSpy.mockRestore();
  });

  it("reindexes when replaced in place by a larger, different file (not a blended append)", async () => {
    // Bug: classify()'s fingerprint guard only fired when the new size EXACTLY
    // equalled the stored offset, so an atomic replace with DIFFERENT, LONGER
    // content fell through to the "appended" fast path — resuming the OLD
    // reducer state and folding only the new tail, blending two conversations.
    // Exercised via scan() (force=false), the path that classify actually gates;
    // refreshFile() would mask it by forcing a reindex regardless.
    //
    // The fix compares fingerprint(current, offset) — first 4KB + the 4KB ending
    // at the offset — against the stored fingerprint. It catches every real
    // rewrite (line 1 changes → different head 4KB), which is what this asserts.
    // A rewrite preserving BOTH 8KB windows and differing only mid-file is not
    // detected — the same bounded ceiling as the existing edge-fingerprint, by
    // design; not exercised here.
    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "OLD conversation content here")}\n${asst("2026-01-01T00:00:01.000Z", "old reply")}\n`,
    );
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profile(), configDir: dir }] });
    const oldOffset = cursorOf(dbPath, file)?.last_indexed_offset;

    // Replace in place with an ENTIRELY DIFFERENT, LONGER conversation (new
    // sessionId, new cwd, more/longer lines). Size grows past the old cursor and
    // mtime moves, so classify's "grew past cursor" branch is taken.
    const replacement = [
      JSON.stringify({
        type: "user",
        uuid: "u-new-1",
        timestamp: "2026-05-01T00:00:00.000Z",
        sessionId: "sess-NEW",
        slug: "new-session",
        cwd: "/home/new",
        message: {
          role: "user",
          content: [
            { type: "text", text: "completely different opening prompt with lots of words" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a-new-1",
        timestamp: "2026-05-01T00:00:01.000Z",
        sessionId: "sess-NEW",
        message: {
          role: "assistant",
          model: "m",
          content: [
            { type: "text", text: "a much longer assistant reply than anything in the old file" },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "u-new-2",
        timestamp: "2026-05-01T00:00:02.000Z",
        sessionId: "sess-NEW",
        message: { role: "user", content: [{ type: "text", text: "second new user turn" }] },
      }),
    ].join("\n");
    writeFileSync(file, `${replacement}\n`);
    expect(statSync(file).size).toBeGreaterThan(oldOffset ?? 0);

    // Second scan reconciles the replaced file. It must reindex from 0, not
    // resume the old fold. Assert on the INDEXED ConversationMeta (what the
    // corruption blends), compared field-for-field against a full parseMeta of
    // the new file.
    const s2 = new ConversationScanner({ persistent: { dbPath } });
    const result = await s2.scan({ profiles: [{ ...profile(), configDir: dir }] });
    s2.close();
    scanner.close();

    const metas = result.conversations as ConversationMeta[];
    expect(metas).toHaveLength(1);
    const meta = metas[0];
    const full = await parseMeta(file, "default", resolveTier("standard"));

    // No blend of old sessionId / cwd / count / preview — pure reparse of the new.
    expect(meta.sessionId).toBe("sess-NEW");
    expect(meta.projectPath).toBe("/home/new");
    expect(meta.messageCount).toBe(full?.messageCount);
    expect(meta.preview).toBe(full?.preview);
    expect(meta.preview).not.toContain("OLD conversation");
    // Cursor landed at the new EOF, not the stale old offset.
    expect(cursorOf(dbPath, file)?.last_indexed_offset).toBe(statSync(file).size);
  });

  it("still takes the append fast-path for a genuine append via scan()", async () => {
    // Guard against over-correcting: a real append (same head bytes, more tail)
    // must still resume from the cursor, not reindex from 0.
    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "genuine first")}\n${asst("2026-01-01T00:00:01.000Z", "reply")}\n`,
    );
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profile(), configDir: dir }] });
    const offsetAfterFirst = cursorOf(dbPath, file)?.last_indexed_offset;
    scanner.close();

    fs.appendFileSync(
      file,
      `${user("2026-01-02T00:00:00.000Z", "appended line")}\n${asst("2026-01-02T00:00:01.000Z", "appended reply")}\n`,
    );
    const sizeAfter = statSync(file).size;

    const s2 = new ConversationScanner({ persistent: { dbPath } });
    await s2.scan({ profiles: [{ ...profile(), configDir: dir }] });
    const meta = await s2.getConversation("sess-inc");
    s2.close();

    // The cursor advanced to the new EOF (resumed, not reset), the sessionId is
    // preserved, and the meta equals a full reparse.
    const c = cursorOf(dbPath, file);
    expect(c?.last_indexed_offset).toBe(sizeAfter);
    expect(offsetAfterFirst).toBeLessThan(sizeAfter);
    const full = await parseMeta(file, "default", resolveTier("standard"));
    expect(meta?.messageCount).toBe(full?.messageCount);
    expect(meta?.sessionId).toBe("sess-inc");
  });

  it("survives a restart: a new engine resumes from the persisted cursor", async () => {
    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "before restart")}\n${asst("2026-01-01T00:00:01.000Z", "ok")}\n`,
    );
    const first = new ConversationScanner({ persistent: { dbPath } });
    await first.scan({ profiles: [{ ...profile(), configDir: dir }] });
    first.close();

    const sizeBeforeRestart = statSync(file).size;
    fs.appendFileSync(file, `${user("2026-01-05T00:00:00.000Z", "after restart")}\n`);
    const sizeAfter = statSync(file).size;

    // The cursor persisted before the restart sits at the pre-append EOF.
    expect(cursorOf(dbPath, file)?.last_indexed_offset).toBe(sizeBeforeRestart);

    const second = new ConversationScanner({ persistent: { dbPath } });
    const meta = await second.refreshFile(file);
    second.close();

    expect(meta?.messageCount).toBe(3);
    // Resumed across the restart and advanced to the new EOF.
    expect(cursorOf(dbPath, file)?.last_indexed_offset).toBe(sizeAfter);
  });
});
