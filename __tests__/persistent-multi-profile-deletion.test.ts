import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/persistent/db";
import { ConversationFilesRepo } from "../src/persistent/repositories/conversation-files.repo";
import { ConversationScanner } from "../src/scanner";

// Count active (non-deleted) file rows in the shared index.db directly.
function activeCount(dbPath: string): number {
  const db = openDatabase(dbPath);
  const n = new ConversationFilesRepo(db).allActivePaths().length;
  db.close();
  return n;
}

// A scan of one profile must not mark another profile's already-indexed files
// deleted just because they share one index.db. Before the fix, indexAll's
// deletion-reconcile used a GLOBAL allActivePaths() and marked every active
// file not in THIS scan's discovered set as deleted — so scanning profile B
// wiped profile A. Combined with the dir-mtime gate (which then skips the glob
// for A's unchanged dir on the next scan), A's rows stayed deleted permanently.

function convLine(sessionId: string, cwd: string) {
  return JSON.stringify({
    type: "user",
    uuid: `u-${sessionId}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId,
    slug: sessionId,
    cwd,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
}

describe("cross-profile deletion-reconcile scoping", () => {
  let dir: string;
  let dbPath: string;
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mpd-"));
    dbPath = join(dir, "index.db");
    // Two separate config dirs → two profiles with distinct accounts (ids),
    // both indexing into the SAME index.db (dbPath).
    dirA = join(dir, "configA");
    dirB = join(dir, "configB");
    const projA = join(dirA, "projects", "-proj-a");
    const projB = join(dirB, "projects", "-proj-b");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    writeFileSync(join(projA, "a.jsonl"), `${convLine("sess-a", "/proj-a")}\n`);
    writeFileSync(join(projB, "b.jsonl"), `${convLine("sess-b", "/proj-b")}\n`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const profileA = () => ({ id: "acct-a", label: "A", configDir: dirA, enabled: true });
  const profileB = () => ({ id: "acct-b", label: "B", configDir: dirB, enabled: true });

  const scanWith = async (profiles: ReturnType<typeof profileA>[], opts = {}) => {
    const s = new ConversationScanner({ persistent: { dbPath } });
    const res = await s.scan({ profiles, ...opts });
    await s.close();
    return res.total;
  };

  it("scanning profile B does not delete profile A's files", async () => {
    // Index A (account acct-a) → 1 active file in the index.
    await scanWith([profileA()]);
    expect(activeCount(dbPath)).toBe(1);

    // Index B (account acct-b), same shared index.db. B's scan must NOT mark
    // A's file deleted — A is simply out of B's scope, not gone from disk.
    await scanWith([profileB()]);
    // Both A and B are active in the shared index; A was not wiped by B's scan.
    expect(activeCount(dbPath)).toBe(2);

    // Re-scan A (gated: A's dir mtime is unchanged, so the glob is skipped).
    // With the fix, A's row was never deleted, so both remain active.
    await scanWith([profileA()]);
    expect(activeCount(dbPath)).toBe(2);
  });

  it("scanning profile B still deletes B's own genuinely-removed file", async () => {
    // Prove the deletion backstop still works WITHIN a scan's own scope.
    await scanWith([profileA()]);
    await scanWith([profileB()]);
    expect(activeCount(dbPath)).toBe(2); // A + B both indexed

    // Remove B's file from disk, re-scan B with fullRescan so the gate globs and
    // discovers the removal (a gated skip would reuse the cached list; we want
    // to exercise the deletion path itself).
    rmSync(join(dirB, "projects", "-proj-b", "b.jsonl"));
    await scanWith([profileB()], { fullRescan: true });

    // B's file is dropped from the index; A's remains untouched.
    expect(activeCount(dbPath)).toBe(1);
  });
});
