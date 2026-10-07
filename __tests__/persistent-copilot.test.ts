import { cpSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/persistent/db";
import { ConversationScanner } from "../src/scanner";
import type { ConversationMeta } from "../src/types";

const FIXTURES = join(__dirname, "..", "__fixtures__", "copilot");
const BASIC_ID = "00000000-0000-4000-8000-000000000001";
const TOOLS_ID = "00000000-0000-4000-8000-0000000000a1";

function plant(root: string, sessionId: string, fixture: string): string {
  const dest = join(root, sessionId, "events.jsonl");
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(join(FIXTURES, fixture), dest);
  return dest;
}

describe("persistent SQLite Copilot indexing", () => {
  let dir: string;
  let copilotRoot: string;
  let dbPath: string;
  let toolsPath: string;

  const newScanner = () => new ConversationScanner({ persistent: { dbPath } });
  const scanOptions = () => ({
    profiles: [],
    providers: ["copilot" as const],
    copilotRoots: [copilotRoot],
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "copilot-sqlite-"));
    dbPath = join(dir, "index.db");
    copilotRoot = join(dir, "session-state");
    plant(copilotRoot, BASIC_ID, "basic-session.jsonl");
    toolsPath = plant(copilotRoot, TOOLS_ID, "session-with-tools.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persistent scan finds Copilot files from copilotRoots", async () => {
    const scanner = newScanner();
    const result = await scanner.scan(scanOptions());
    const convos = result.conversations as ConversationMeta[];
    expect(convos).toHaveLength(2);
    expect(convos.every((c) => c.provider === "copilot")).toBe(true);
    scanner.close();
  });

  it("does not index Copilot unless copilotRoots given", async () => {
    const scanner = newScanner();
    const result = await scanner.scan({ profiles: [], providers: ["copilot"] });
    expect((result.conversations as ConversationMeta[]).length).toBe(0);
    scanner.close();
  });

  it("stores Copilot rows in SQLite with provider/preview/count", async () => {
    const scanner = newScanner();
    await scanner.scan(scanOptions());
    scanner.close();

    const db = openDatabase(dbPath);
    const rows = db
      .prepare("SELECT * FROM conversations WHERE provider = 'copilot' AND status = 'active'")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);

    const tools = rows.find((r) => r.session_id === TOOLS_ID);
    expect(tools).toBeTruthy();
    expect(tools?.message_count).toBe(2);
    expect(String(tools?.preview ?? "")).toContain("List the files");
    db.close();
  });

  it("getConversation resolves a Copilot file by path and by sessionId", async () => {
    const scanner = newScanner();
    await scanner.scan(scanOptions());

    const byPath = await scanner.getConversation(toolsPath);
    expect(byPath?.messages).toHaveLength(3);

    const bySession = await scanner.getConversation(BASIC_ID);
    expect(bySession?.messages).toHaveLength(2);
    expect(scanner.getConversationsBySessionId(BASIC_ID)).toHaveLength(1);
    scanner.close();
  });

  it("refreshing a Copilot file keeps it a Copilot row", async () => {
    const scanner = newScanner();
    await scanner.scan(scanOptions());
    const meta = await scanner.refreshFile(toolsPath);
    expect(meta?.provider).toBe("copilot");
    expect(meta?.toolNames).toContain("bash");
    scanner.close();
  });

  it("indexes a Copilot file the index has never seen via refreshFile", async () => {
    const scanner = newScanner();
    const meta = await scanner.refreshFile(toolsPath);
    expect(meta?.provider).toBe("copilot");
    expect(meta?.messageCount).toBe(2);
    scanner.close();
  });

  it("drops a deleted session on refresh and on rescan", async () => {
    const scanner = newScanner();
    await scanner.scan(scanOptions());
    expect(scanner.getConversationsBySessionId(TOOLS_ID)).toHaveLength(1);

    rmSync(toolsPath);
    await scanner.refreshFile(toolsPath);
    expect(scanner.getConversationsBySessionId(TOOLS_ID)).toHaveLength(0);

    rmSync(join(copilotRoot, BASIC_ID), { recursive: true });
    const result = await scanner.scan(scanOptions());
    expect(result.conversations as ConversationMeta[]).toHaveLength(0);
    scanner.close();
  });

  it("persistent search finds Copilot text and filters by provider", async () => {
    const scanner = newScanner();
    await scanner.scan(scanOptions());

    const hits = await scanner.search("Python", { provider: "copilot" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].meta.provider).toBe("copilot");

    const none = await scanner.search("Python", { provider: "claude-code" });
    expect(none.length).toBe(0);

    // model.* side-channel text is in the file but must not be searchable.
    expect(await scanner.search("side-channel", { provider: "copilot" })).toHaveLength(0);
    scanner.close();
  });

  it("getConversationPage returns Copilot messages equal to getConversation().messages", async () => {
    const scanner = newScanner();
    await scanner.scan(scanOptions());

    const full = await scanner.getConversation(toolsPath);
    const all = full?.messages ?? [];
    expect(all.length).toBeGreaterThan(1);

    const page = await scanner.getConversationPage(toolsPath, {
      beforeIndex: all.length,
      limit: 50,
    });
    expect(page?.total).toBe(all.length);
    expect(page?.fromIndex).toBe(0);
    expect(page?.messages).toEqual(all);
    scanner.close();
  });

  it("parseSingleFilePage sniffs a Copilot file with no index row", async () => {
    const scanner = newScanner();
    const page = await scanner.parseSingleFilePage(toolsPath, undefined, { limit: 50 });
    expect(page?.total).toBe(3);
    expect(page?.conversation.sessionId).toBe(TOOLS_ID);
    scanner.close();
  });
});
