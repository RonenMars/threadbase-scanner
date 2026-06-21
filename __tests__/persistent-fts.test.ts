import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";
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

describe("persistent FTS5 search", () => {
  let dir: string;
  let dbPath: string;
  let profile: Profile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fts-"));
    dbPath = join(dir, "i.db");
    const pd = join(dir, "projects", "proj");
    mkdirSync(pd, { recursive: true });
    writeFileSync(
      join(pd, "a.jsonl"),
      `${user("sa", "2026-01-01T00:00:00.000Z", "authentication bug in the login flow")}\n`,
    );
    writeFileSync(
      join(pd, "b.jsonl"),
      `${user("sb", "2026-02-01T00:00:00.000Z", "database migration for postgres")}\n`,
    );
    writeFileSync(
      join(pd, "c.jsonl"),
      `${user("sc", "2026-03-01T00:00:00.000Z", "authentication token refresh")}\n`,
    );
    profile = { id: "default", label: "T", configDir: dir, enabled: true };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function scanner() {
    return new ConversationScanner({ persistent: { dbPath } });
  }

  it("finds conversations by a content term", async () => {
    const s = scanner();
    const hits = await s.search("authentication", { profiles: [profile] });
    const ids = hits.map((h) => h.meta.sessionId).sort();
    expect(ids).toEqual(["sa", "sc"]);
    s.close();
  });

  it("supports prefix matching like the in-memory forward tokenizer", async () => {
    const s = scanner();
    const hits = await s.search("postg", { profiles: [profile] });
    expect(hits.map((h) => h.meta.sessionId)).toEqual(["sb"]);
    s.close();
  });

  it("ANDs multiple terms", async () => {
    const s = scanner();
    const hits = await s.search("authentication token", { profiles: [profile] });
    expect(hits.map((h) => h.meta.sessionId)).toEqual(["sc"]);
    s.close();
  });

  it("builds content match snippets", async () => {
    const s = scanner();
    const hits = await s.search("migration", { profiles: [profile] });
    expect(hits[0].matches.some((m) => m.snippet.includes("migration"))).toBe(true);
    s.close();
  });

  it("empty query returns recent conversations newest-first", async () => {
    const s = scanner();
    const hits = await s.search("", { profiles: [profile] });
    expect(hits.map((h) => h.meta.sessionId)).toEqual(["sc", "sb", "sa"]);
    s.close();
  });

  it("respects project/since filters after the FTS match", async () => {
    const s = scanner();
    const recent = await s.search("authentication", { profiles: [profile], since: "2026-02-15" });
    expect(recent.map((h) => h.meta.sessionId)).toEqual(["sc"]);
    s.close();
  });

  it("reflects refreshed content incrementally", async () => {
    const s = scanner();
    await s.search("authentication", { profiles: [profile] });

    // Append a new searchable term to a.jsonl and refresh just that file.
    const a = join(dir, "projects", "proj", "a.jsonl");
    writeFileSync(
      a,
      `${user("sa", "2026-01-01T00:00:00.000Z", "authentication bug in the login flow")}\n${user("sa", "2026-01-02T00:00:00.000Z", "supercalifragilistic keyword")}\n`,
    );
    await s.refreshFile(a);

    const hits = await s.search("supercalifragilistic", { profiles: [profile] });
    expect(hits.map((h) => h.meta.sessionId)).toEqual(["sa"]);
    s.close();
  });

  it("drops a deleted conversation from the index", async () => {
    const s = scanner();
    await s.search("database", { profiles: [profile] });

    const b = join(dir, "projects", "proj", "b.jsonl");
    writeFileSync(b, "");
    await s.refreshFile(b);

    const hits = await s.search("database", { profiles: [profile] });
    expect(hits).toHaveLength(0);
    s.close();
  });

  it("persists the FTS index across a restart (no re-scan)", async () => {
    const first = scanner();
    await first.search("authentication", { profiles: [profile] });
    first.close();

    // New instance, same DB, search WITHOUT passing profiles — must hit the
    // persisted FTS index, not rescan.
    const second = scanner();
    const hits = await second.search("postgres");
    expect(hits.map((h) => h.meta.sessionId)).toEqual(["sb"]);
    second.close();
  });
});
