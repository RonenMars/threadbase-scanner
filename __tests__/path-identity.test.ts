import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/persistent/db";
import { ConversationFilesRepo } from "../src/persistent/repositories/conversation-files.repo";
import { ConversationScanner } from "../src/scanner";

// A conversation file is discovered by fast-glob (which emits forward slashes
// even on Windows) but looked up by the watcher / path.join() (native
// separators). Both spellings of the exact same absolute path must resolve to
// the SAME stored row — otherwise a by-path lookup misses on Windows and a
// refresh inserts a duplicate under the second separator style. On POSIX the two
// spellings are identical, so this is a no-op smoke test there.
describe("path identity across separator styles", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "path-id-"));
    mkdirSync(join(dir, "projects", "proj"), { recursive: true });
    dbPath = join(dir, "i.db");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = () => ({ id: "default", label: "T", configDir: dir, enabled: true });

  function line(ts: string, text: string) {
    return JSON.stringify({
      type: "user",
      uuid: `u-${ts}`,
      timestamp: ts,
      sessionId: "sess-path",
      slug: "p",
      cwd: "/home/p",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  }

  it("resolves a native-separator lookup and a forward-slash lookup to the same conversation", async () => {
    const nativePath = join(dir, "projects", "proj", "c.jsonl");
    writeFileSync(nativePath, `${line("2026-01-01T00:00:00.000Z", "hi")}\n`);
    // The forward-slash spelling of the very same file (what fast-glob emits).
    const posixPath = nativePath.split(sep).join("/");

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });

    const byNative = await scanner.getConversation(nativePath);
    const byPosix = await scanner.getConversation(posixPath);
    scanner.close();

    expect(byNative).not.toBeNull();
    expect(byPosix).not.toBeNull();
    // Same underlying row: identical sessionId, stored file path, and messages.
    expect(byNative?.sessionId).toBe("sess-path");
    expect(byPosix?.sessionId).toBe(byNative?.sessionId);
    expect(byPosix?.filePath).toBe(byNative?.filePath);
    expect(byPosix?.messages).toEqual(byNative?.messages);
  });

  it("refreshFile through either separator form updates one row, not two", async () => {
    const nativePath = join(dir, "projects", "proj", "c.jsonl");
    writeFileSync(nativePath, `${line("2026-01-01T00:00:00.000Z", "one")}\n`);
    const posixPath = nativePath.split(sep).join("/");

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });

    // Refresh through both spellings; each must land on the one existing row
    // rather than insert a duplicate under a second separator spelling.
    await scanner.refreshFile(nativePath);
    await scanner.refreshFile(posixPath);

    const all = scanner.getConversationsBySessionId("sess-path");
    scanner.close();
    expect(all).toHaveLength(1);
  });

  // The invariant at its narrowest: the repository — not any particular caller —
  // is what collapses the two spellings onto one row.
  it("ConversationFilesRepo.ensure/getByPath resolve both spellings to one row", () => {
    const nativePath = join(dir, "projects", "proj", "repo.jsonl");
    const posixPath = nativePath.split(sep).join("/");

    const db = openDatabase(dbPath);
    const files = new ConversationFilesRepo(db);

    const idFromPosix = files.ensure(posixPath, "default");
    const idFromNative = files.ensure(nativePath, "default");
    expect(idFromNative).toBe(idFromPosix);

    // Both lookups hit that same row...
    expect(files.getByPath(posixPath)?.id).toBe(idFromPosix);
    expect(files.getByPath(nativePath)?.id).toBe(idFromPosix);

    // ...and only one row exists, stored under the canonical spelling.
    const rows = db.prepare("SELECT absolute_path, parent_dir FROM conversation_files").all() as {
      absolute_path: string;
      parent_dir: string;
    }[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].absolute_path).toBe(nativePath);
    expect(rows[0].parent_dir).toBe(join(dir, "projects", "proj"));
  });
});
