import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as discoveryModule from "../src/discovery";
import { openDatabase } from "../src/persistent/db";
import { ConversationScanner } from "../src/scanner";

function user(sessionId: string, text: string) {
  return JSON.stringify({
    type: "user",
    uuid: `u-${sessionId}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId,
    slug: sessionId,
    cwd: `/home/${sessionId}`,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

// Issue #73: a migration that drops FTS and resets cursors relies on the next
// indexAll to backfill. The dir-mtime gate must not hide unchanged dirs from it.
describe("FTS backfill after a cursor-resetting migration, behind the dir-mtime gate", () => {
  let dir: string;
  let projectsDir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fts-backfill-"));
    projectsDir = join(dir, "config", "projects");
    mkdirSync(projectsDir, { recursive: true });
    dbPath = join(dir, "i.db");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = () => ({
    id: "default",
    label: "T",
    configDir: join(dir, "config"),
    enabled: true,
  });

  const counts = () => {
    const db = openDatabase(dbPath);
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM conversations WHERE status = 'active') AS conv,
           (SELECT COUNT(*) FROM conversation_messages_fts) AS fts,
           (SELECT COUNT(*) FROM conversation_files WHERE last_indexed_offset = 0) AS off0`,
      )
      .get() as { conv: number; fts: number; off0: number };
    db.close();
    return row;
  };

  it("gives every conversation an FTS row again without any dir mtime moving", async () => {
    for (const name of ["proj-a", "proj-b", "proj-c"]) {
      mkdirSync(join(projectsDir, name));
      writeFileSync(join(projectsDir, name, `${name}.jsonl`), `${user(name, `needle ${name}`)}\n`);
    }
    const s1 = new ConversationScanner({ persistent: { dbPath } });
    await s1.scan({ profiles: [profile()] });
    s1.close();
    expect(counts()).toEqual({ conv: 3, fts: 3, off0: 0 });

    const mtimes = () =>
      ["", "proj-a", "proj-b", "proj-c"].map((n) => statSync(join(projectsDir, n)).mtimeMs);
    const before = mtimes();

    // Roll the stored version back to 4 so the real v4 → v5 migration runs on the
    // next open: it drops the FTS table and resets every cursor to 0.
    const raw = new Database(dbPath);
    raw.pragma("user_version = 4");
    raw.close();
    expect(counts()).toEqual({ conv: 3, fts: 0, off0: 3 });

    const spy = vi.spyOn(discoveryModule, "discoverJsonlFiles");
    const s2 = new ConversationScanner({ persistent: { dbPath } });
    await s2.scan({ profiles: [profile()] });
    const hits = await s2.search("needle", { profiles: [profile()] });
    s2.close();

    // Positive control: nothing on disk moved, so the gate reused every
    // watermark and never globbed — the backfill ran through the skip path.
    expect(mtimes()).toEqual(before);
    expect(spy).not.toHaveBeenCalled();

    expect(counts()).toEqual({ conv: 3, fts: 3, off0: 0 });
    expect(hits).toHaveLength(3);
  });
});
