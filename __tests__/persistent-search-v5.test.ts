import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/persistent/db";
import { FtsRepo } from "../src/persistent/repositories/fts.repo";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/persistent/schema";
import { ConversationScanner } from "../src/scanner";
import { SEARCH_BUDGET } from "../src/search-document";
import type { Profile } from "../src/types";

function userText(sid: string, ts: string, text: string, cwd = "/home/proj") {
  return `${JSON.stringify({
    type: "user",
    uuid: `${sid}-${ts}`,
    timestamp: ts,
    sessionId: sid,
    slug: sid,
    cwd,
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

describe("schema v5", () => {
  let dir: string;
  let dbPath: string;
  let projectDir: string;
  let profile: Profile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "v5-"));
    dbPath = join(dir, "i.db");
    projectDir = join(dir, "projects", "proj");
    mkdirSync(projectDir, { recursive: true });
    profile = { id: "default", label: "T", configDir: dir, enabled: true };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const scanner = () => new ConversationScanner({ persistent: { dbPath } });

  describe("v4 -> v5 migration", () => {
    // A faithful v4 database: identical to the current schema except the FTS
    // table, which still has the single head-biased `content` column. Building
    // it from the real SCHEMA_SQL keeps this fixture from drifting as unrelated
    // columns are added elsewhere.
    function buildV4Db(sourcePath: string) {
      const v4 = new Database(dbPath);
      v4.exec(SCHEMA_SQL);
      v4.exec("DROP TABLE conversation_messages_fts");
      v4.exec(`CREATE VIRTUAL TABLE conversation_messages_fts USING fts5(
        source_path UNINDEXED, content, project_name, session_id, session_name,
        account, model, branch, tool_names, tokenize = 'unicode61')`);

      // A cursor claiming the file is already fully indexed — without a reset,
      // classify() would call it unchanged and never rebuild the corpus.
      v4.prepare(
        `INSERT INTO conversation_files
           (id, absolute_path, parent_dir, file_name, last_indexed_offset, last_indexed_line, reducer_state)
         VALUES (1, ?, ?, 'a.jsonl', 4242, 9, '{"stale":true}')`,
      ).run(sourcePath, projectDir);
      v4.prepare(
        "INSERT INTO conversations (file_id, source_path, session_id, message_count) VALUES (1, ?, 'sa', 3)",
      ).run(sourcePath);
      v4.prepare(
        "INSERT INTO conversation_messages_fts (source_path, content) VALUES (?, 'OLDCORPUSNEEDLE')",
      ).run(sourcePath);

      v4.pragma("user_version = 4");
      v4.close();
    }

    it("stamps v5, drops the stale FTS corpus and resets cursors without reading JSONL", () => {
      const file = join(projectDir, "a.jsonl");
      writeFileSync(file, userText("sa", "2026-01-01T00:00:00.000Z", "hello"));
      buildV4Db(file);

      const db = openDatabase(dbPath);

      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);

      // Old corpus gone, so the head-biased 5 KB rows can't linger.
      const ftsCount = db.prepare("SELECT COUNT(*) AS n FROM conversation_messages_fts").get() as {
        n: number;
      };
      expect(ftsCount.n).toBe(0);

      // Cursor reset is the entire rebuild trigger: classify() reindexes from 0
      // whenever last_indexed_offset === 0.
      const row = db
        .prepare(
          "SELECT last_indexed_offset, last_indexed_line, reducer_state FROM conversation_files WHERE id = 1",
        )
        .get() as { last_indexed_offset: number; last_indexed_line: number; reducer_state: null };
      expect(row.last_indexed_offset).toBe(0);
      expect(row.last_indexed_line).toBe(0);
      expect(row.reducer_state).toBeNull();

      // The conversation row itself survives — migration is not a wipe.
      const convs = db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number };
      expect(convs.n).toBe(1);

      db.close();
    });

    it("rebuilds the new corpus on the next scan, including deep body content", async () => {
      const file = join(projectDir, "a.jsonl");
      const filler = "preamble words here ".repeat(500);
      writeFileSync(
        file,
        userText("sa", "2026-01-01T00:00:00.000Z", filler) +
          userText("sa", "2026-01-01T00:01:00.000Z", "POSTMIGRATIONNEEDLE deep in the body"),
      );
      buildV4Db(file);

      const s = scanner();
      await s.scan({ profiles: [profile] });
      const hits = await s.search("POSTMIGRATIONNEEDLE", { profiles: [profile] });
      const stale = await s.search("OLDCORPUSNEEDLE", { profiles: [profile] });
      s.close();

      expect(hits.map((h) => h.meta.sessionId)).toEqual(["sa"]);
      expect(stale).toHaveLength(0);
    });
  });

  describe("filters run in SQL before LIMIT", () => {
    beforeEach(() => {
      // 12 conversations share the term; only the last belongs to `other`. With
      // post-filtering over a truncated list, a small limit would return none.
      for (let i = 0; i < 11; i++) {
        writeFileSync(
          join(projectDir, `p${i}.jsonl`),
          userText(
            `s${i}`,
            `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
            "SHAREDTERM here",
            "/home/main",
          ),
        );
      }
      writeFileSync(
        join(projectDir, "target.jsonl"),
        userText("target", "2026-01-20T00:00:00.000Z", "SHAREDTERM here", "/home/other"),
      );
    });

    it("finds a conversation that only survives the project filter", async () => {
      const s = scanner();
      await s.scan({ profiles: [profile] });
      const hits = await s.search("SHAREDTERM", {
        profiles: [profile],
        project: "other",
        limit: 2,
      });
      s.close();

      expect(hits.map((h) => h.meta.sessionId)).toEqual(["target"]);
    });

    it("applies the since filter in SQL", async () => {
      const s = scanner();
      await s.scan({ profiles: [profile] });
      const hits = await s.search("SHAREDTERM", {
        profiles: [profile],
        since: "2026-01-15",
        limit: 2,
      });
      s.close();

      expect(hits.map((h) => h.meta.sessionId)).toEqual(["target"]);
    });
  });

  describe("FTS write skipping", () => {
    // Re-tokenizing a ~128 KB row is the expensive part of an append, so an
    // unchanged row must not be rewritten — but "unchanged" has to include the
    // metadata columns, or a renamed session would keep its stale value forever
    // since nothing else ever rewrites this row.

    it("does not rewrite the FTS row when a rescan changes nothing", async () => {
      writeFileSync(
        join(projectDir, "a.jsonl"),
        userText("sa", "2026-01-01T00:00:00.000Z", "stable content"),
      );

      const s = scanner();
      await s.scan({ profiles: [profile] });

      const upsertSpy = vi.spyOn(FtsRepo.prototype, "upsert");
      await s.scan({ profiles: [profile], fullRescan: true });
      const hits = await s.search("stable", { profiles: [profile] });
      s.close();

      expect(upsertSpy).not.toHaveBeenCalled();
      expect(hits).toHaveLength(1);
      upsertSpy.mockRestore();
    });

    it("DOES rewrite when only a metadata column changed", async () => {
      const file = join(projectDir, "a.jsonl");
      writeFileSync(file, userText("oldname", "2026-01-01T00:00:00.000Z", "identical body text"));

      const s = scanner();
      await s.scan({ profiles: [profile] });

      // Same body, different slug -> session_name/session_id move while the
      // three buckets stay byte-identical.
      writeFileSync(file, userText("newname", "2026-01-01T00:00:00.000Z", "identical body text"));

      const upsertSpy = vi.spyOn(FtsRepo.prototype, "upsert");
      await s.scan({ profiles: [profile], fullRescan: true });
      const hits = await s.search("newname", { profiles: [profile] });
      s.close();

      expect(upsertSpy).toHaveBeenCalled();
      expect(hits.map((h) => h.meta.sessionId)).toEqual(["newname"]);
      upsertSpy.mockRestore();
    });
  });

  describe("in-memory vs persistent recall", () => {
    // Same extraction rules both sides; different indexed VOLUME. The in-memory
    // forward index is capped to the tier's snippetMax because it is resident
    // memory, so a term in the dropped head is a persistent-only hit.
    const bigFile = () =>
      userText("sa", "2026-01-01T00:00:00.000Z", `HEADONLYNEEDLE ${"filler words ".repeat(2000)}`) +
      userText("sa", "2026-01-02T00:00:00.000Z", "TAILNEEDLE at the end");

    beforeEach(() => {
      writeFileSync(join(projectDir, "a.jsonl"), bigFile());
    });

    it("shares extraction rules: both engines find a term in the tail", async () => {
      const persistent = scanner();
      const persistentHits = await persistent.search("TAILNEEDLE", { profiles: [profile] });
      persistent.close();

      const memory = new ConversationScanner({ persistent: false });
      const memoryHits = await memory.search("TAILNEEDLE", { profiles: [profile] });
      memory.close();

      expect(persistentHits.map((h) => h.meta.sessionId)).toEqual(["sa"]);
      expect(memoryHits.map((h) => h.meta.sessionId)).toEqual(["sa"]);
    });

    it("diverges on volume: the in-memory index is capped to the tier snippetMax", async () => {
      // Sanity: the fixture really is bigger than the in-memory cap but inside
      // the persistent budget, otherwise this asserts nothing.
      expect(bigFile().length).toBeGreaterThan(5_000);
      expect(bigFile().length).toBeLessThan(SEARCH_BUDGET.textMax);

      const persistent = scanner();
      const persistentHits = await persistent.search("HEADONLYNEEDLE", { profiles: [profile] });
      persistent.close();

      const memory = new ConversationScanner({ persistent: false });
      const memoryHits = await memory.search("HEADONLYNEEDLE", { profiles: [profile] });
      memory.close();

      expect(persistentHits.map((h) => h.meta.sessionId)).toEqual(["sa"]);
      expect(memoryHits).toHaveLength(0);
    });
  });
});
