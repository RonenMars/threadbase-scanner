import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner, type ScannerChangeEvent } from "../src/scanner";
import type { Profile } from "../src/types";

function user(sid: string, ts: string, text: string) {
  return JSON.stringify({
    type: "user",
    uuid: `${sid}-${ts}`,
    timestamp: ts,
    sessionId: sid,
    slug: sid,
    cwd: "/home/proj",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

// Wait for a "change" event matching a predicate, or reject after timeoutMs.
function waitForChange(
  scanner: ConversationScanner,
  match: (e: ScannerChangeEvent) => boolean,
  timeoutMs = 4000,
): Promise<ScannerChangeEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      scanner.off("change", onChange);
      reject(new Error("timed out waiting for change event"));
    }, timeoutMs);
    function onChange(e: ScannerChangeEvent) {
      if (match(e)) {
        clearTimeout(timer);
        scanner.off("change", onChange);
        resolve(e);
      }
    }
    scanner.on("change", onChange);
  });
}

describe("file watcher", () => {
  let dir: string;
  let pd: string;
  let dbPath: string;
  let profile: Profile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watch-"));
    pd = join(dir, "projects", "proj");
    mkdirSync(pd, { recursive: true });
    dbPath = join(dir, "i.db");
    profile = { id: "default", label: "T", configDir: dir, enabled: true };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes a newly created file and emits a change event", async () => {
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile] });
    await scanner.watch({ profiles: [profile], debounceMs: 50, periodicMs: 0 });

    const newFile = join(pd, "fresh.jsonl");
    const evP = waitForChange(scanner, (e) => e.filePath === newFile && e.meta != null);
    writeFileSync(newFile, `${user("fresh", "2026-04-01T00:00:00.000Z", "newly created convo")}\n`);

    const ev = await evP;
    expect(ev.meta?.messageCount).toBe(1);
    expect(scanner.getMetadataCache().has(newFile)).toBe(true);

    await scanner.unwatch();
    scanner.close();
  });

  it("emits a change with null meta when a watched file is removed", async () => {
    const f = join(pd, "gone.jsonl");
    writeFileSync(f, `${user("gone", "2026-04-01T00:00:00.000Z", "will be deleted")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile] });
    expect(scanner.getMetadataCache().has(f)).toBe(true);

    await scanner.watch({ profiles: [profile], debounceMs: 50, periodicMs: 0 });
    const evP = waitForChange(scanner, (e) => e.filePath === f);
    rmSync(f);

    const ev = await evP;
    expect(ev.meta).toBeNull();
    expect(scanner.getMetadataCache().has(f)).toBe(false);

    await scanner.unwatch();
    scanner.close();
  });

  it("throws when watch() is called in legacy in-memory mode", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    await expect(scanner.watch({ profiles: [profile] })).rejects.toThrow(/persistent/);
  });
});
