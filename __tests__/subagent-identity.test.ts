// Provider-created child sessions ("subagents") must carry their OWN identity.
//
// A Claude sidechain transcript stores its PARENT's id in the `sessionId`
// field, so `sessionId` alone collapses every sibling subagent — and the parent
// — onto one identity. `subagentId` / `parentSessionUuid` separate them without
// touching `sessionId`, whose meaning every persisted consumer already depends
// on (see the regression guard below).
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMeta } from "../src/parser";
import { finalizeMeta, initialReducerState } from "../src/persistent/metadata-reducer";
import { runMigrations } from "../src/persistent/migrations";
import { SCHEMA_VERSION } from "../src/persistent/schema";
import { CodexCliProvider } from "../src/providers/codex-cli";
import { parseMetaWithProvider } from "../src/providers/parse";
import { ConversationScanner } from "../src/scanner";
import { resolveTier } from "../src/tiers";
import type { ConversationMeta, Profile } from "../src/types";

const FIXTURES = join(__dirname, "..", "__fixtures__");
const CODEX_FIXTURES = join(FIXTURES, "codex-cli");
const TIER = resolveTier("standard");

const PARENT_UUID = "3a741076-d6e8-43f0-920c-5fd270bd8770";

const claude = (file: string) => parseMeta(join(FIXTURES, file), "default", TIER);
const codex = (file: string): Promise<ConversationMeta | null> =>
  parseMetaWithProvider(new CodexCliProvider(), join(CODEX_FIXTURES, file), "codex", TIER);

// finalizeMeta is exercised directly for the path-shape tests: the fallback is
// a property of the PATH STRING, and a Windows path cannot be read from disk on
// a POSIX test runner.
function metaForPath(filePath: string): ConversationMeta {
  const state = initialReducerState();
  state.messageCount = 1;
  const meta = finalizeMeta(state, filePath, "default", TIER);
  if (!meta) throw new Error("expected meta");
  return meta;
}

describe("Claude sidechain identity (explicit JSONL fields)", () => {
  it("lifts agentId and the parent id to conversation level", async () => {
    const meta = await claude("subagent-sidechain.jsonl");
    expect(meta?.isSubagent).toBe(true);
    expect(meta?.subagentId).toBe("ab22e887a11a1ba50");
    expect(meta?.parentSessionUuid).toBe(PARENT_UUID);
  });

  // REGRESSION GUARD for the non-negotiable constraint: `sessionId` keeps the
  // value it has always had (the parent's id, verbatim from the JSONL). Every
  // consumer has this persisted; repurposing it for the child would silently
  // shift the meaning of ids already in their databases.
  it("leaves sessionId UNCHANGED on a sidechain file", async () => {
    const meta = await claude("subagent-sidechain.jsonl");
    expect(meta?.sessionId).toBe(PARENT_UUID);
    // ...and the child's own id is reachable, but only via the new field.
    expect(meta?.sessionId).not.toBe(meta?.subagentId);
  });

  it("distinguishes two subagents spawned by the same parent", async () => {
    const a = await claude("subagent-sidechain.jsonl");
    const b = await claude("subagent-sidechain-sibling.jsonl");

    // The bug being fixed: these two are identical on sessionId alone.
    expect(a?.sessionId).toBe(b?.sessionId);

    expect(a?.subagentId).toBe("ab22e887a11a1ba50");
    expect(b?.subagentId).toBe("addbace6884a6b055");
    expect(a?.subagentId).not.toBe(b?.subagentId);
    expect(a?.parentSessionUuid).toBe(b?.parentSessionUuid);
  });
});

describe("Claude subagent path fallback (no explicit fields)", () => {
  const POSIX_SUB = "/home/u/.claude/projects/proj/3a741076/subagents/agent-abc.jsonl";

  // The exact transform canonicalPath() applies on Windows (`sep === "\\"`), so
  // these are the strings the discovery layer really hands finalizeMeta there —
  // fully backslashed, not hand-written mixed separators. discovery.ts
  // canonicalizes every discovered path this way and index-engine.ts does it
  // again before the reduce, so on Windows a forward-slash substring test can
  // never match: detection was not flaky there, it was always false.
  const asWindows = (p: string) => p.replace(/\//g, "\\");
  const WINDOWS_SUB = asWindows(POSIX_SUB);

  it("detects a subagent from a POSIX path and reports the parent JSONL path", () => {
    const meta = metaForPath(POSIX_SUB);
    expect(meta.isSubagent).toBe(true);
    expect(meta.parentSessionId).toBe("/home/u/.claude/projects/proj/3a741076.jsonl");
    // No explicit fields on disk means no child id and no parent UUID to lift.
    expect(meta.subagentId).toBeUndefined();
    expect(meta.parentSessionUuid).toBeUndefined();
  });

  // The scanner is handed NATIVE paths. A hardcoded "/subagents/" never matches
  // on Windows, so detection was silently dead there — a clean false negative
  // that passes trivially on POSIX. This assertion is the only thing that
  // catches a regression back to a single-separator test.
  it("detects a subagent from a Windows path", () => {
    // Guard the guard: if this ever stops being an all-backslash path, the test
    // silently degrades into a duplicate of the POSIX case above.
    expect(WINDOWS_SUB).not.toContain("/");
    expect(WINDOWS_SUB).toContain("\\subagents\\");
    expect(metaForPath(WINDOWS_SUB).isSubagent).toBe(true);
  });

  // Positive control for the two negatives below: proves the matcher actually
  // discriminates rather than answering true (or false) for everything.
  it("does not treat an ordinary path as a subagent, on either separator", () => {
    expect(metaForPath("/home/u/.claude/projects/proj/plain.jsonl").isSubagent).toBe(false);
    expect(metaForPath("C:\\Users\\u\\.claude\\projects\\proj\\plain.jsonl").isSubagent).toBe(
      false,
    );
  });
});

describe("ordinary Claude conversations", () => {
  it("leaves all three subagent fields absent", async () => {
    const meta = await claude("valid-conversation.jsonl");
    expect(meta?.isSubagent).toBe(false);
    expect(meta?.subagentId).toBeUndefined();
    expect(meta?.parentSessionUuid).toBeUndefined();
    // Positive control: the same parse DOES populate identity fields, so the
    // three assertions above are not passing on a null/empty meta.
    expect(meta?.sessionId).toBe("sess-abc");
  });
});

describe("Codex subagent sources", () => {
  it("reads thread_spawn as a subagent with a parent thread id", async () => {
    const meta = await codex("subagent-thread-spawn.jsonl");
    expect(meta?.isSubagent).toBe(true);
    expect(meta?.parentSessionUuid).toBe("019fc6f6-95f5-75d1-9e86-97e12c7bbff6");
    // Codex exposes no per-child id of its own.
    expect(meta?.subagentId).toBeUndefined();
  });

  // {"subagent":"review"} — the subagent VALUE is a string, not an object. A
  // shape-based check (expecting a dict) reports these as ordinary sessions.
  it("treats a string-valued subagent source as a subagent", async () => {
    const meta = await codex("subagent-string-value.jsonl");
    expect(meta?.isSubagent).toBe(true);
    expect(meta?.parentSessionUuid).toBeUndefined();
  });

  // {"subagent":{"other":"guardian"}} — a subagent with no discoverable parent.
  it("treats an 'other' subagent source as a subagent with no parent", async () => {
    const meta = await codex("subagent-other.jsonl");
    expect(meta?.isSubagent).toBe(true);
    expect(meta?.parentSessionUuid).toBeUndefined();
  });

  it("treats string sources such as 'exec' as ordinary sessions", async () => {
    const meta = await codex("exec-source.jsonl");
    expect(meta?.isSubagent).toBe(false);
    expect(meta?.parentSessionUuid).toBeUndefined();
    // Positive control: the file really did parse.
    expect(meta?.sessionId).toBe("01a009d3-b7a8-7513-a85a-469cf5d8d4a3");
  });

  it("treats a session_meta with no source at all as an ordinary session", async () => {
    const meta = await codex("basic-session.jsonl");
    expect(meta?.isSubagent).toBe(false);
    expect(meta?.subagentId).toBeUndefined();
    expect(meta?.parentSessionUuid).toBeUndefined();
    expect(meta?.sessionId).toBe("sess-basic-0001");
  });
});

// The two new columns are folded out of the JSONL, so an already-indexed
// database must both GAIN the columns and be told to reparse — otherwise every
// subagent already on disk keeps NULL forever, since nothing appends to a
// finished transcript and nothing else would ever rebuild the row.
describe("v5 → v6 migration on an existing database", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagent-migration-"));
    db = new Database(join(dir, "index.db"));
    // A v5-shaped database: the pre-v6 columns only.
    db.exec(`
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL UNIQUE,
        source_path TEXT NOT NULL UNIQUE,
        session_id TEXT,
        -- The columns SCHEMA_SQL's indexes reference; a real v5 database has
        -- all of these (provider arrived in the v1 -> v2 migration).
        provider TEXT NOT NULL DEFAULT 'claude-code',
        timestamp TEXT,
        project_path TEXT,
        branch TEXT,
        account TEXT NOT NULL DEFAULT 'default',
        team_name TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        parent_session_id TEXT
      );
      CREATE TABLE conversation_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        absolute_path TEXT NOT NULL UNIQUE,
        parent_dir TEXT NOT NULL,
        file_name TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT 'default',
        last_indexed_offset INTEGER NOT NULL DEFAULT 0,
        last_indexed_line INTEGER NOT NULL DEFAULT 0,
        reducer_state TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      INSERT INTO conversations (file_id, source_path, session_id)
        VALUES (1, '/p/sub.jsonl', 'parent-uuid');
      INSERT INTO conversation_files
        (absolute_path, parent_dir, file_name, last_indexed_offset, last_indexed_line, reducer_state)
        VALUES ('/p/sub.jsonl', '/p', 'sub.jsonl', 4096, 12, '{"sessionId":"parent-uuid"}');
    `);
    db.pragma("user_version = 5");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const columns = () =>
    (db.pragma("table_info(conversations)") as Array<{ name: string }>).map((c) => c.name);

  it("adds the identity columns that a v5 database lacks", () => {
    // Positive control: prove they are genuinely absent first, so the
    // post-migration assertion cannot pass vacuously.
    expect(columns()).not.toContain("subagent_id");
    expect(columns()).not.toContain("parent_session_uuid");

    runMigrations(db);

    expect(columns()).toContain("subagent_id");
    expect(columns()).toContain("parent_session_uuid");
    // Against the constant, not a literal: the intent is "migrated to current",
    // and a hardcoded number turns every future schema bump into a failure here
    // that has nothing to do with subagent identity.
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("preserves existing rows and resets the cursor so they reindex", () => {
    runMigrations(db);

    const row = db.prepare("SELECT * FROM conversations WHERE file_id = 1").get() as Record<
      string,
      unknown
    >;
    // Non-destructive: the pre-existing data survives, new columns default NULL.
    expect(row.session_id).toBe("parent-uuid");
    expect(row.subagent_id).toBeNull();

    const file = db
      .prepare("SELECT * FROM conversation_files WHERE absolute_path = '/p/sub.jsonl'")
      .get() as Record<string, unknown>;
    // last_indexed_offset === 0 is the entire reindex trigger.
    expect(file.last_indexed_offset).toBe(0);
    expect(file.last_indexed_line).toBe(0);
    expect(file.reducer_state).toBeNull();
  });
});

// End-to-end through the real pipeline (discovery -> canonicalPath -> index
// engine -> finalizeMeta), on the exact shape that demonstrates the defect: one
// parent with TWO children. A single-child fixture cannot catch a collapse.
describe("end-to-end scan: two subagents under one parent", () => {
  let tempDir: string;
  let profile: Profile;

  const line = (sessionId: string, extra: Record<string, unknown>) =>
    JSON.stringify({
      type: "user",
      uuid: `u-${Math.random()}`,
      timestamp: "2026-01-15T10:00:00.000Z",
      sessionId,
      cwd: "/tmp/proj",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
      ...extra,
    });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "subagent-e2e-"));
    const proj = join(tempDir, "projects", "-tmp-proj");
    const subs = join(proj, "parentuuid", "subagents");
    mkdirSync(subs, { recursive: true });

    writeFileSync(join(proj, "parentuuid.jsonl"), `${line("parentuuid", {})}\n`);
    for (const id of ["one", "two"]) {
      writeFileSync(
        join(subs, `agent-${id}.jsonl`),
        `${line("parentuuid", { isSidechain: true, agentId: id })}\n`,
      );
    }
    profile = { id: "test", label: "Test", configDir: tempDir, enabled: true };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("separates the children while leaving the parent and sessionId alone", async () => {
    const result = await new ConversationScanner().scan({ profiles: [profile] });
    const metas = result.conversations as ConversationMeta[];
    expect(metas).toHaveLength(3);

    const parent = metas.find((m) => m.filePath.endsWith("parentuuid.jsonl"));
    const one = metas.find((m) => m.filePath.endsWith("agent-one.jsonl"));
    const two = metas.find((m) => m.filePath.endsWith("agent-two.jsonl"));
    for (const m of [parent, one, two]) expect(m).toBeDefined();

    // Behaviour that must NOT regress: this is what 0.15.0 already gets right
    // on POSIX, verified at runtime against the published build.
    expect(parent?.isSubagent).toBe(false);
    expect(parent?.parentSessionId).toBeNull();
    expect(one?.isSubagent).toBe(true);
    expect(two?.isSubagent).toBe(true);
    expect(one?.parentSessionId).toBe(parent?.filePath);
    expect(two?.parentSessionId).toBe(parent?.filePath);

    // The defect: all three still report one and the same sessionId, and that
    // stays true — consumers have it persisted.
    expect(parent?.sessionId).toBe("parentuuid");
    expect(one?.sessionId).toBe("parentuuid");
    expect(two?.sessionId).toBe("parentuuid");

    // The fix: the children are now separable, and point at their parent.
    expect(one?.subagentId).toBe("one");
    expect(two?.subagentId).toBe("two");
    expect(one?.subagentId).not.toBe(two?.subagentId);
    expect(one?.parentSessionUuid).toBe("parentuuid");
    expect(two?.parentSessionUuid).toBe("parentuuid");
    // Positive control for the two negatives on the parent above.
    expect(parent?.subagentId).toBeUndefined();
    expect(parent?.parentSessionUuid).toBeUndefined();
  });
});
