import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";

// Builds a project tree big enough that scan() takes long enough to still be
// in flight when close() lands a few ms later.
function buildProjects(configDir: string, dirs = 30, filesPerDir = 8, linesPerFile = 40): void {
  const root = join(configDir, "projects");
  for (let d = 0; d < dirs; d++) {
    const pd = join(root, `-proj-${d}`);
    mkdirSync(pd, { recursive: true });
    for (let f = 0; f < filesPerDir; f++) {
      let lines = "";
      for (let l = 0; l < linesPerFile; l++) {
        lines += `${JSON.stringify({
          type: "user",
          uuid: `u-${d}-${f}-${l}`,
          timestamp: "2026-01-01T00:00:00.000Z",
          sessionId: `s-${d}-${f}`,
          cwd: `/proj-${d}`,
          message: { role: "user", content: [{ type: "text", text: "x".repeat(200) }] },
        })}\n`;
      }
      writeFileSync(join(pd, `c-${f}.jsonl`), lines);
    }
  }
}

describe("close() during an in-flight scan (Bug #4)", () => {
  let dir: string;
  let dbPath: string;
  let configDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "close-scan-"));
    dbPath = join(dir, "index.db");
    configDir = join(dir, "config");
    mkdirSync(configDir, { recursive: true });
    buildProjects(configDir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const profiles = () => [{ id: "p", label: "P", configDir, enabled: true }];

  // 3(a): the core regression — close() must not shut the DB out from under a
  // scan still running on the SAME instance. Before the fix, close() closed the
  // handle synchronously and the in-flight indexAll() threw
  // "database connection is not open".
  it("does not crash a scan running on the same instance when close() lands mid-scan", async () => {
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    // Prime once so the DB exists and a second scan has cursors to compare.
    await scanner.scan({ profiles: [{ ...profiles()[0] }] });

    const scanPromise = scanner.scan({ profiles: profiles() });
    // close() lands while the scan is still in flight. It must await the scan
    // (not close the DB under it), so neither the scan nor close() throws.
    const closePromise = new Promise<void>((resolve) => {
      setTimeout(() => resolve(scanner.close()), 3);
    });

    await expect(scanPromise).resolves.toBeTruthy();
    await expect(closePromise).resolves.toBeUndefined();
  });

  // 3(a) variant: close() returns only AFTER the scan has finished touching the
  // DB — proving it awaits rather than racing.
  it("close() awaits the in-flight scan before releasing the handle", async () => {
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [{ ...profiles()[0] }] });

    let scanSettled = false;
    const scanPromise = scanner.scan({ profiles: profiles() }).then((r) => {
      scanSettled = true;
      return r;
    });
    // Kick off close() a hair after the scan starts; when it resolves, the scan
    // must already be done.
    await new Promise((r) => setTimeout(r, 2));
    await scanner.close();
    expect(scanSettled).toBe(true);
    await scanPromise;
  });

  // 3(b): two independent instances on the SAME dbPath (separate better-sqlite3
  // handles, no JS pool). Closing one mid-scan on the other must not affect the
  // other's scan — confirms there is no file-level contention that a close()'s
  // WAL checkpoint could inflict on a concurrent reader/writer. (Documents the
  // no-sharing invariant; would catch a regression if pooling/locking were ever
  // introduced.)
  it("closing one instance mid-scan does not crash another instance on the same dbPath", async () => {
    const a = new ConversationScanner({ persistent: { dbPath } });
    const b = new ConversationScanner({ persistent: { dbPath } });
    // Prime b's handle on the shared file.
    await b.scan({ profiles: profiles() });

    const scanA = a.scan({ profiles: profiles() });
    // Close B (its own independent handle) while A scans.
    await new Promise((r) => setTimeout(r, 2));
    await b.close();

    await expect(scanA).resolves.toBeTruthy();
    await a.close();
  });
});
