import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSidecar, sidecarPath } from "../src/persistent/sidecar";
import { ConversationScanner } from "../src/scanner";
import type { Profile } from "../src/types";

function user(ts: string, text: string) {
  return JSON.stringify({
    type: "user",
    uuid: `u-${ts}`,
    timestamp: ts,
    sessionId: "sc",
    slug: "sc",
    cwd: "/home/proj",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

describe("sidecar .idx.json", () => {
  let dir: string;
  let file: string;
  let dbPath: string;
  let profile: Profile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidecar-"));
    const pd = join(dir, "projects", "proj");
    mkdirSync(pd, { recursive: true });
    file = join(pd, "c.jsonl");
    writeFileSync(file, `${user("2026-01-01T00:00:00.000Z", "hello sidecar")}\n`);
    dbPath = join(dir, "i.db");
    profile = { id: "default", label: "T", configDir: dir, enabled: true };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not written by default", async () => {
    const s = new ConversationScanner({ persistent: { dbPath } });
    await s.scan({ profiles: [profile] });
    expect(existsSync(sidecarPath(file))).toBe(false);
    s.close();
  });

  it("is written next to the JSONL when enabled and is readable", async () => {
    const s = new ConversationScanner({ persistent: { dbPath, sidecar: true } });
    await s.scan({ profiles: [profile] });
    s.close();

    expect(existsSync(sidecarPath(file))).toBe(true);
    const sc = readSidecar(file);
    expect(sc?.version).toBe(1);
    expect(sc?.sourcePath).toBe(file);
    expect(sc?.messageCount).toBe(1);
    expect(sc?.lastSentText).toContain("hello sidecar");
    expect(sc?.lastIndexedOffset).toBeGreaterThan(0);
  });

  it("updates the sidecar on an incremental refresh", async () => {
    const s = new ConversationScanner({ persistent: { dbPath, sidecar: true } });
    await s.scan({ profiles: [profile] });

    writeFileSync(
      file,
      `${user("2026-01-01T00:00:00.000Z", "hello sidecar")}\n${user("2026-01-02T00:00:00.000Z", "second message")}\n`,
    );
    await s.refreshFile(file);
    s.close();

    const sc = readSidecar(file);
    expect(sc?.messageCount).toBe(2);
    expect(sc?.lastSentText).toContain("second message");
  });
});
