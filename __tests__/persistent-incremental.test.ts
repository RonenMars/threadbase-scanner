import * as fs from "fs";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMeta } from "../src/parser";
import { openDatabase } from "../src/persistent/db";
import { ConversationFilesRepo } from "../src/persistent/repositories/conversation-files.repo";
import { ConversationScanner } from "../src/scanner";
import { resolveTier } from "../src/tiers";

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
