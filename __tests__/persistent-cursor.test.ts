import { cpSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/persistent/db";
import { ConversationScanner } from "../src/scanner";
import type { ConversationMeta } from "../src/types";

const FIXTURES = join(__dirname, "..", "__fixtures__", "cursor-cli");

function plant(
  root: string,
  sessionId: string,
  fixture: string,
  slug = "Users-dev-widget",
): string {
  const dest = join(root, slug, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(join(FIXTURES, fixture), dest);
  return dest;
}

describe("persistent SQLite Cursor indexing", () => {
  let dir: string;
  let cursorRoot: string;
  let dbPath: string;

  const newScanner = () => new ConversationScanner({ persistent: { dbPath } });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cursor-sqlite-"));
    dbPath = join(dir, "index.db");
    cursorRoot = join(dir, "cursor");
    plant(cursorRoot, "sess-basic-0001", "basic-session.jsonl");
    plant(cursorRoot, "sess-tools-0002", "session-with-tools.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persistent scan finds Cursor files from cursorRoots", async () => {
    const scanner = newScanner();
    const result = await scanner.scan({
      profiles: [],
      providers: ["cursor-cli"],
      cursorRoots: [cursorRoot],
    });
    const convos = result.conversations as ConversationMeta[];
    expect(convos).toHaveLength(2);
    expect(convos.every((c) => c.provider === "cursor-cli")).toBe(true);
    scanner.close();
  });

  it("does not index Cursor unless cursorRoots given", async () => {
    const scanner = newScanner();
    const result = await scanner.scan({ profiles: [], providers: ["cursor-cli"] });
    expect((result.conversations as ConversationMeta[]).length).toBe(0);
    scanner.close();
  });

  it("stores Cursor rows in SQLite with provider/preview/count", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["cursor-cli"], cursorRoots: [cursorRoot] });
    scanner.close();

    const db = openDatabase(dbPath);
    const rows = db
      .prepare("SELECT * FROM conversations WHERE provider = 'cursor-cli' AND status = 'active'")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);

    const tools = rows.find((r) => r.session_id === "sess-tools-0002");
    expect(tools).toBeTruthy();
    expect(tools?.provider).toBe("cursor-cli");
    expect((tools?.message_count as number) > 0).toBe(true);
    expect(String(tools?.preview ?? "").length).toBeGreaterThan(0);
    db.close();
  });

  it("getConversation resolves a Cursor file by path and by sessionId", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["cursor-cli"], cursorRoots: [cursorRoot] });

    const byPath = await scanner.getConversation(
      join(
        cursorRoot,
        "Users-dev-widget",
        "agent-transcripts",
        "sess-basic-0001",
        "sess-basic-0001.jsonl",
      ),
    );
    expect(byPath).not.toBeNull();
    expect(byPath?.messageCount).toBeGreaterThan(0);

    const bySession = await scanner.getConversation("sess-basic-0001");
    expect(bySession).not.toBeNull();
    expect(scanner.getConversationsBySessionId("sess-basic-0001")).toHaveLength(1);
    scanner.close();
  });

  it("keeps duplicate sessionIds non-unique and resolves deterministically", async () => {
    plant(
      cursorRoot,
      "shared-id-9999",
      "multiple-sessions-same-session-id.jsonl",
      "Users-dev-alpha",
    );
    plant(
      cursorRoot,
      "shared-id-9999",
      "multiple-sessions-same-session-id-newer.jsonl",
      "Users-dev-beta",
    );
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["cursor-cli"], cursorRoots: [cursorRoot] });

    const all = scanner.getConversationsBySessionId("shared-id-9999");
    expect(all).toHaveLength(2);
    const convo = await scanner.getConversation("shared-id-9999");
    expect(convo?.messages.some((m) => m.text.includes("Newer copy"))).toBe(true);
    scanner.close();
  });

  it("deleting one duplicate-session file does not hide the other", async () => {
    const older = plant(
      cursorRoot,
      "shared-id-9999",
      "multiple-sessions-same-session-id.jsonl",
      "Users-dev-alpha",
    );
    const newer = plant(
      cursorRoot,
      "shared-id-9999",
      "multiple-sessions-same-session-id-newer.jsonl",
      "Users-dev-beta",
    );

    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["cursor-cli"], cursorRoots: [cursorRoot] });
    expect(scanner.getConversationsBySessionId("shared-id-9999")).toHaveLength(2);

    rmSync(newer);
    await scanner.refreshFile(newer);

    const remaining = scanner.getConversationsBySessionId("shared-id-9999");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].filePath).toBe(older.replace(/\\/g, "/"));
    scanner.close();
  });

  it("refreshing a Cursor file updates its SQLite row", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["cursor-cli"], cursorRoots: [cursorRoot] });
    const path = join(
      cursorRoot,
      "Users-dev-widget",
      "agent-transcripts",
      "sess-tools-0002",
      "sess-tools-0002.jsonl",
    );

    const meta = await scanner.refreshFile(path);
    expect(meta).not.toBeNull();
    expect(meta?.provider).toBe("cursor-cli");
    expect(meta?.toolNames).toContain("Grep");
    scanner.close();
  });

  it("persistent search finds Cursor text and filters by provider", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["cursor-cli"], cursorRoots: [cursorRoot] });

    const hits = await scanner.search("Python", { provider: "cursor-cli" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].meta.provider).toBe("cursor-cli");

    const none = await scanner.search("Python", { provider: "claude-code" });
    expect(none.length).toBe(0);
    scanner.close();
  });

  it("getConversationPage returns Cursor messages equal to getConversation().messages", async () => {
    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["cursor-cli"], cursorRoots: [cursorRoot] });
    const path = join(
      cursorRoot,
      "Users-dev-widget",
      "agent-transcripts",
      "sess-tools-0002",
      "sess-tools-0002.jsonl",
    );

    const full = await scanner.getConversation(path);
    expect(full).not.toBeNull();
    const all = full?.messages ?? [];
    expect(all.length).toBeGreaterThan(1);

    const page = await scanner.getConversationPage(path, {
      beforeIndex: all.length,
      limit: 50,
    });
    expect(page).not.toBeNull();
    expect(page?.total).toBe(all.length);
    expect(page?.fromIndex).toBe(0);
    expect(page?.messages).toEqual(all);
    scanner.close();
  });

  it("persists import-provenance flags from Cursor transcripts", async () => {
    plant(cursorRoot, "sess-imported-claude", "imported-from-claude.jsonl");
    plant(cursorRoot, "sess-imported-codex", "imported-from-codex.jsonl");
    plant(cursorRoot, "sess-imported-field", "imported-from-claude-field.jsonl");

    const scanner = newScanner();
    await scanner.scan({ profiles: [], providers: ["cursor-cli"], cursorRoots: [cursorRoot] });
    scanner.close();

    const db = openDatabase(dbPath);
    const rows = db
      .prepare(
        "SELECT session_id, is_imported_from_claude, is_imported_from_codex, is_imported_from_cursor FROM conversations WHERE provider = 'cursor-cli'",
      )
      .all() as Array<{
      session_id: string;
      is_imported_from_claude: number;
      is_imported_from_codex: number;
      is_imported_from_cursor: number;
    }>;

    const native = rows.find((r) => r.session_id === "sess-basic-0001");
    expect(native?.is_imported_from_claude).toBe(0);
    expect(native?.is_imported_from_codex).toBe(0);
    expect(native?.is_imported_from_cursor).toBe(0);

    const claude = rows.find((r) => r.session_id === "sess-imported-claude");
    expect(claude?.is_imported_from_claude).toBe(1);
    expect(claude?.is_imported_from_codex).toBe(0);

    const codex = rows.find((r) => r.session_id === "sess-imported-codex");
    expect(codex?.is_imported_from_claude).toBe(0);
    expect(codex?.is_imported_from_codex).toBe(1);

    const field = rows.find((r) => r.session_id === "sess-imported-field");
    expect(field?.is_imported_from_claude).toBe(1);
    db.close();
  });
});
