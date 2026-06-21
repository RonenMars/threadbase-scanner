// Codex CLI conversations indexed/searched/fetched through the SQLite persistent
// engine (Phase 2). Mirrors the in-memory codex-provider tests, but every
// scanner is constructed persistent (a real on-disk DB in a temp dir) so the
// rows actually round-trip through SQLite.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/persistent/db";
import { ConversationScanner } from "../src/scanner";
import type { ConversationMeta } from "../src/types";

const FIXTURES = join(__dirname, "..", "__fixtures__", "codex-cli");

describe("persistent SQLite Codex indexing", () => {
  let dir: string;
  let codexRoot: string;
  let dbPath: string;

  const newScanner = () => new ConversationScanner({ persistent: { dbPath } });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-sqlite-"));
    dbPath = join(dir, "index.db");
    codexRoot = join(dir, "codex");
    const day = join(codexRoot, "2026", "06", "18");
    mkdirSync(day, { recursive: true });
    cpSync(join(FIXTURES, "basic-session.jsonl"), join(day, "rollout-basic.jsonl"));
    cpSync(join(FIXTURES, "session-with-tools.jsonl"), join(day, "rollout-tools.jsonl"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persistent scan finds Codex files from codexRoots", async () => {
    const scanner = newScanner();
    const result = await scanner.scan({
      profiles: [],
      providers: ["codex-cli"],
      codexRoots: [codexRoot],
    });
    const convos = result.conversations as ConversationMeta[];
    expect(convos).toHaveLength(2);
    expect(convos.every((c) => c.provider === "codex-cli")).toBe(true);
    scanner.close();
  });

  it("does not index Codex unless codexRoots given", async () => {
    const scanner = newScanner();
    const result = await scanner.scan({ profiles: [], providers: ["codex-cli"] });
    expect((result.conversations as ConversationMeta[]).length).toBe(0);
    scanner.close();
  });

  it("stores Codex rows in SQLite with provider/model/branch/preview/count", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });
    scanner.close();

    // Re-read straight from the DB to prove the row persisted (not just held in
    // memory). A fresh scanner reuses the same DB file without re-scanning.
    const db = openDatabase(dbPath);
    const rows = db
      .prepare("SELECT * FROM conversations WHERE provider = 'codex-cli' AND status = 'active'")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);

    const tools = rows.find((r) => r.session_id === "sess-tools-0002");
    expect(tools).toBeTruthy();
    expect(tools?.provider).toBe("codex-cli");
    expect(tools?.model).toBe("gpt-5.5");
    expect(tools?.branch).toBe("feat/search");
    expect(tools?.external_session_id).toBe("sess-tools-0002");
    expect((tools?.message_count as number) > 0).toBe(true);
    expect(String(tools?.preview ?? "").length).toBeGreaterThan(0);
    db.close();
  });

  it("getConversation resolves a Codex file by path and by sessionId", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });

    const byPath = await scanner.getConversation(
      join(codexRoot, "2026", "06", "18", "rollout-basic.jsonl"),
    );
    expect(byPath).not.toBeNull();
    expect(byPath?.messageCount).toBeGreaterThan(0);

    const bySession = await scanner.getConversation("sess-basic-0001");
    expect(bySession).not.toBeNull();
    expect(scanner.getConversationsBySessionId("sess-basic-0001")).toHaveLength(1);
    scanner.close();
  });

  it("keeps duplicate sessionIds non-unique and resolves deterministically", async () => {
    const day = join(codexRoot, "2026", "06", "18");
    cpSync(
      join(FIXTURES, "multiple-sessions-same-session-id.jsonl"),
      join(day, "rollout-older.jsonl"),
    );
    cpSync(
      join(FIXTURES, "multiple-sessions-same-session-id-newer.jsonl"),
      join(day, "rollout-newer.jsonl"),
    );
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });

    const all = scanner.getConversationsBySessionId("shared-id-9999");
    expect(all).toHaveLength(2);
    // Newest indexed first (index_seq desc); the newer file was indexed last.
    const convo = await scanner.getConversation("shared-id-9999");
    expect(convo?.projectPath).toBe("/Users/dev/projects/beta");
    scanner.close();
  });

  it("deleting one duplicate-session file does not hide the other", async () => {
    const day = join(codexRoot, "2026", "06", "18");
    const older = join(day, "rollout-older.jsonl");
    const newer = join(day, "rollout-newer.jsonl");
    cpSync(join(FIXTURES, "multiple-sessions-same-session-id.jsonl"), older);
    cpSync(join(FIXTURES, "multiple-sessions-same-session-id-newer.jsonl"), newer);

    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });
    expect(scanner.getConversationsBySessionId("shared-id-9999")).toHaveLength(2);

    rmSync(newer);
    await scanner.refreshFile(newer);

    const remaining = scanner.getConversationsBySessionId("shared-id-9999");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].projectPath).toBe("/Users/dev/projects/alpha");
    scanner.close();
  });

  it("refreshing a Codex file updates its SQLite row", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });
    const path = join(codexRoot, "2026", "06", "18", "rollout-tools.jsonl");

    const meta = await scanner.refreshFile(path);
    expect(meta).not.toBeNull();
    expect(meta?.provider).toBe("codex-cli");
    expect(meta?.model).toBe("gpt-5.5");
    expect(meta?.toolNames).toContain("shell");
    scanner.close();
  });

  it("persistent search finds Codex text and filters by provider", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [codexRoot] });

    const hits = await scanner.search("Python", { provider: "codex-cli" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].meta.provider).toBe("codex-cli");

    const none = await scanner.search("Python", { provider: "claude-code" });
    expect(none.length).toBe(0);
    scanner.close();
  });
});
