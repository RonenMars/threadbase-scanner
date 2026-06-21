import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationScanner } from "../src/scanner";
import type { Profile, ScanOptions } from "../src/types";

// Build a small but varied history so parity covers subagents, teammates,
// multiple projects, and a range of timestamps.
function userLine(sessionId: string, ts: string, cwd: string, text: string, extra: object = {}) {
  return JSON.stringify({
    type: "user",
    uuid: `${sessionId}-${ts}`,
    timestamp: ts,
    sessionId,
    slug: `${sessionId}-slug`,
    cwd,
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  });
}
function asstLine(sessionId: string, ts: string, text: string) {
  return JSON.stringify({
    type: "assistant",
    uuid: `${sessionId}-${ts}-a`,
    timestamp: ts,
    sessionId,
    message: { role: "assistant", model: "claude-x", content: [{ type: "text", text }] },
  });
}

describe("persistent vs in-memory parity", () => {
  let tempDir: string;
  let profile: Profile;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "parity-"));
    const projects = join(tempDir, "projects");
    const projA = join(projects, "alpha");
    const projB = join(projects, "beta");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    // subagents live under a /subagents/ path segment to trip isSubagent.
    const sub = join(projA, "subagents", "uuid");
    mkdirSync(sub, { recursive: true });

    writeFileSync(
      join(projA, "s1.jsonl"),
      `${[
        userLine("s1", "2026-01-10T10:00:00.000Z", "/home/alpha", "hello alpha"),
        asstLine("s1", "2026-01-10T10:00:05.000Z", "hi from alpha"),
      ].join("\n")}\n`,
    );
    writeFileSync(
      join(projB, "s2.jsonl"),
      `${[
        userLine("s2", "2026-03-01T09:00:00.000Z", "/home/beta", "fix the beta bug"),
        asstLine("s2", "2026-03-01T09:00:10.000Z", "fixed it"),
        userLine("s2", "2026-03-01T09:01:00.000Z", "/home/beta", "thanks"),
      ].join("\n")}\n`,
    );
    writeFileSync(
      join(sub, "s3.jsonl"),
      `${[
        userLine("s3", "2026-02-15T12:00:00.000Z", "/home/alpha", "subagent task"),
        asstLine("s3", "2026-02-15T12:00:03.000Z", "subagent done"),
      ].join("\n")}\n`,
    );

    profile = { id: "test", label: "Test", configDir: tempDir, enabled: true };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Run identical scan options through both backends and assert deep equality.
  const matrix: ScanOptions[] = [
    {},
    { sort: "recent" },
    { sort: "oldest" },
    { sort: "messages-desc" },
    { sort: "messages-asc" },
    { sort: "alpha" },
    { include: "conversations" },
    { include: "subagents" },
    { view: "tree" },
    { view: "grouped" },
    { project: "beta" },
    { since: "2026-02-01" },
    { limit: 1, offset: 0 },
    { limit: 1, offset: 1 },
  ];

  for (const opts of matrix) {
    it(`scan() parity for ${JSON.stringify(opts)}`, async () => {
      const mem = new ConversationScanner({ persistent: false });
      const memResult = await mem.scan({ ...opts, profiles: [profile] });

      const persistent = new ConversationScanner({ persistent: { dbPath: join(tempDir, "p.db") } });
      const pResult = await persistent.scan({ ...opts, profiles: [profile] });
      persistent.close();

      expect(pResult).toEqual(memResult);
    });
  }

  it("getProjects() parity", async () => {
    const mem = new ConversationScanner({ persistent: false });
    await mem.scan({ profiles: [profile] });

    const p = new ConversationScanner({ persistent: { dbPath: join(tempDir, "p.db") } });
    await p.scan({ profiles: [profile] });
    expect(p.getProjects()).toEqual(mem.getProjects());
    p.close();
  });

  it("search() parity (result metas match)", async () => {
    const mem = new ConversationScanner({ persistent: false });
    const memHits = await mem.search("beta", { profiles: [profile] });

    const p = new ConversationScanner({ persistent: { dbPath: join(tempDir, "p.db") } });
    const pHits = await p.search("beta", { profiles: [profile] });
    p.close();

    expect(pHits.map((h) => h.meta.id).sort()).toEqual(memHits.map((h) => h.meta.id).sort());
  });

  it("persists across a fresh scanner instance (no re-scan needed)", async () => {
    const dbPath = join(tempDir, "p.db");
    const first = new ConversationScanner({ persistent: { dbPath } });
    await first.scan({ profiles: [profile] });
    first.close();

    // New instance, same DB, query WITHOUT scanning — data should still be there.
    const second = new ConversationScanner({ persistent: { dbPath } });
    const metas = second.getMetadataCache();
    expect(metas.size).toBe(3);
    const conv = await second.getConversation("s2");
    expect(conv?.messageCount).toBeGreaterThan(0);
    second.close();
  });

  it("getConversation resolves by both source path and session id", async () => {
    const dbPath = join(tempDir, "p.db");
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile] });

    const bySession = await scanner.getConversation("s2");
    expect(bySession).not.toBeNull();
    const byPath = await scanner.getConversation(bySession?.filePath as string);
    expect(byPath?.id).toBe(bySession?.id);
    scanner.close();
  });
});
