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
  timeoutMs = 12_000,
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

  it("indexes a newly created file while watching", async () => {
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile] });
    // Periodic rescan backstops any add event dropped under parallel-test FS
    // load (watcher for speed, periodic scan for correctness).
    await scanner.watch({ profiles: [profile], debounceMs: 50, periodicMs: 300 });

    const newFile = join(pd, "fresh.jsonl");
    writeFileSync(newFile, `${user("fresh", "2026-04-01T00:00:00.000Z", "newly created convo")}\n`);

    const deadline = Date.now() + 12_000;
    while (!scanner.getMetadataCache().has(newFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(scanner.getMetadataCache().has(newFile)).toBe(true);
    expect((await scanner.getConversation("fresh"))?.messageCount).toBe(1);

    await scanner.unwatch();
    scanner.close();
  }, 15_000);

  it("emits a change event when a new file appears", async () => {
    // The change-event mechanism (queue → refreshFile → emit) is covered
    // deterministically in index-queue.test.ts. Here we confirm the integration
    // end-to-end. The periodic reconcile is enabled as a backstop so the event
    // fires even when the raw FS event is dropped under parallel test load.
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile] });
    await scanner.watch({ profiles: [profile], debounceMs: 50, periodicMs: 500 });

    const newFile = join(pd, "evented.jsonl");
    const evP = waitForChange(scanner, (e) => e.filePath === newFile && e.meta != null);
    writeFileSync(newFile, `${user("ev", "2026-04-02T00:00:00.000Z", "evented convo")}\n`);

    const ev = await evP;
    expect(ev.meta?.messageCount).toBe(1);

    await scanner.unwatch();
    scanner.close();
  }, 15_000);

  it("removes a deleted file from the index while watching", async () => {
    const f = join(pd, "gone.jsonl");
    writeFileSync(f, `${user("gone", "2026-04-01T00:00:00.000Z", "will be deleted")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile] });
    expect(scanner.getMetadataCache().has(f)).toBe(true);

    // Enable a short periodic rescan as the correctness backstop: even if the
    // raw unlink event is dropped under parallel-test FS load, the rescan
    // reconciles the index. This mirrors the production guarantee (watcher for
    // speed, periodic scan for correctness).
    await scanner.watch({ profiles: [profile], debounceMs: 50, periodicMs: 300 });
    rmSync(f);

    // Poll for the outcome rather than a single fragile event.
    const deadline = Date.now() + 12_000;
    while (scanner.getMetadataCache().has(f) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(scanner.getMetadataCache().has(f)).toBe(false);

    await scanner.unwatch();
    scanner.close();
  }, 15_000);

  it("throws when watch() is called in legacy in-memory mode", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    await expect(scanner.watch({ profiles: [profile] })).rejects.toThrow(/persistent/);
  });
});
