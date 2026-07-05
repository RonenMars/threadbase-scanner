import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/persistent/db";
import { ScannedDirsRepo } from "../src/persistent/repositories/scanned-dirs.repo";
import { ConversationScanner } from "../src/scanner";

// Regression: the dir-mtime gate's reuse branch trusted a scanned_dirs watermark
// as proof that a project dir's files were already indexed, rehydrating the file
// list purely from conversation_files. But indexAll() commits the watermark
// during discovery, BEFORE it writes that dir's conversation_files rows. When two
// scanner connections share one index.db (two streamer instances, or a warm-up +
// a refresh), scanner B can observe A's just-committed watermark in the window
// before A's file rows land — so B's reuse yields zero files and B silently drops
// the dir's conversations. The dir stays "known" (watermark present) so every
// later gated scan keeps skipping the glob → the conversation is 404 forever.
//
// This reproduces that exact intermediate state directly (watermark committed,
// file row absent) rather than racing two scans, so it's deterministic. The fix:
// an empty reuse for a watermarked dir is untrustworthy → fall through to the
// glob, which reads on-disk truth and re-indexes what's actually there.

function user(sessionId: string, ts: string, text: string) {
  return JSON.stringify({
    type: "user",
    uuid: `u-${sessionId}`,
    timestamp: ts,
    sessionId,
    slug: sessionId,
    cwd: `/home/${sessionId}`,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

describe("dir-watermark reuse race (watermark ahead of file rows)", () => {
  let dir: string;
  let projectsDir: string;
  let projectDir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwr-"));
    projectsDir = join(dir, "config", "projects");
    projectDir = join(projectsDir, "-proj-a");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "s1.jsonl"),
      `${user("s1", "2026-01-01T00:00:00.000Z", "hi")}\n`,
    );
    dbPath = join(dir, "i.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = () => ({
    id: "default",
    label: "T",
    configDir: join(dir, "config"),
    enabled: true,
  });

  // fast-glob (absolute:true) yields "/"-separated paths; the gate normalizes the
  // projectsDir the same way. Match that so the seeded watermark keys line up.
  const fwd = (p: string) => p.replace(/\\/g, "/");

  it("recovers a conversation whose watermark was committed before its file row", async () => {
    // Seed the DB into the mid-race state: scanned_dirs watermarks present with
    // the real on-disk mtimes, but conversation_files has NO row for the file yet
    // (the writing connection hadn't committed it when this state was observed).
    const db = openDatabase(dbPath);
    const scannedDirs = new ScannedDirsRepo(db);
    scannedDirs.upsert(fwd(projectsDir), null, statSync(projectsDir).mtimeMs, false);
    scannedDirs.upsert(fwd(projectDir), fwd(projectsDir), statSync(projectDir).mtimeMs, false);
    db.close();

    // A gated scan reads that watermark. Before the fix it reused it, found zero
    // file rows, and returned the conversation as absent. After the fix the empty
    // reuse falls through to the glob and indexes s1 from disk.
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    const conv = await scanner.getConversation("s1");
    await scanner.close();

    expect(conv).not.toBeNull();
    expect(conv?.messages?.length).toBe(1);
  });
});
