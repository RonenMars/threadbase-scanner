// A Codex rollout must survive the two paths that pick a parser without an
// index row to consult: parseSingleFilePage (the cold/fallback read) and the
// non-persistent branch of refreshFile. Both used to assume the Threadbase
// format, so a Codex file parsed to nothing — and refreshFile then evicted it
// from the in-memory index, turning a conversation that exists on disk into a
// "not found". The Claude cases here are the control: they must keep working
// through the untouched parseConversation/parseMeta path.
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";

const FIXTURES = join(__dirname, "..", "__fixtures__", "codex-cli");

function codexTurn(text: string, second: number): string {
  return `${JSON.stringify({
    timestamp: `2026-06-18T17:23:${String(second).padStart(2, "0")}.000Z`,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  })}\n`;
}

function claudeTurn(text: string, uuid: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid,
    sessionId: "sess-claude-0001",
    cwd: "/home/dev/widget",
    timestamp: "2026-06-18T17:22:06.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}

describe("provider resolution on the single-file paths", () => {
  let dir: string;
  let codexFile: string;
  let claudeFile: string;
  let scanner: ConversationScanner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-codex-single-"));
    codexFile = join(dir, "rollout-2026-06-18T17-22-04-sess-basic-0001.jsonl");
    copyFileSync(join(FIXTURES, "basic-session.jsonl"), codexFile);

    const project = join(dir, "projects", "widget");
    mkdirSync(project, { recursive: true });
    claudeFile = join(project, "sess-claude-0001.jsonl");
    appendFileSync(claudeFile, claudeTurn("first", "turn-1"));

    scanner = new ConversationScanner({ persistent: false });
  });

  afterEach(async () => {
    await scanner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("parseSingleFilePage", () => {
    it("parses a Codex rollout instead of returning null", async () => {
      const page = await scanner.parseSingleFilePage(codexFile, "codex", { limit: 10 });
      expect(page).not.toBeNull();
      expect(page?.total).toBe(4);
      expect(page?.messages[0]?.text).toBe("How do I reverse a list in Python?");
    });

    it("pages a Codex rollout that grew, from the new end", async () => {
      appendFileSync(codexFile, codexTurn("and to reverse a string?", 10));
      const page = await scanner.parseSingleFilePage(codexFile, "codex", { limit: 1 });
      expect(page?.total).toBe(5);
      expect(page?.fromIndex).toBe(4);
      expect(page?.messages.map((m) => m.text)).toEqual(["and to reverse a string?"]);
    });

    it("still parses a Claude transcript", async () => {
      const page = await scanner.parseSingleFilePage(claudeFile, "default", { limit: 10 });
      expect(page?.total).toBe(1);
      expect(page?.messages[0]?.text).toBe("first");
    });

    it("still returns null for a file that is not there", async () => {
      expect(
        await scanner.parseSingleFilePage(join(dir, "gone.jsonl"), "codex", { limit: 10 }),
      ).toBeNull();
    });
  });

  describe("refreshFile (non-persistent)", () => {
    it("keeps a Codex rollout indexed instead of dropping it", async () => {
      await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [dir] });
      expect((await scanner.getConversation("sess-basic-0001"))?.messages).toHaveLength(4);

      appendFileSync(codexFile, codexTurn("and to reverse a string?", 10));
      const meta = await scanner.refreshFile(codexFile);

      expect(meta).not.toBeNull();
      expect(meta?.provider).toBe("codex-cli");
      expect(meta?.messageCount).toBe(5);
      expect((await scanner.getConversation("sess-basic-0001"))?.messages).toHaveLength(5);
    });

    it("still refreshes a Claude transcript", async () => {
      expect((await scanner.refreshFile(claudeFile))?.messageCount).toBe(1);
      appendFileSync(claudeFile, claudeTurn("second", "turn-2"));
      expect((await scanner.refreshFile(claudeFile))?.messageCount).toBe(2);
    });

    it("still drops a Codex rollout that was deleted", async () => {
      await scanner.scan({ profiles: [], providers: ["codex-cli"], codexRoots: [dir] });
      expect(await scanner.getConversation("sess-basic-0001")).not.toBeNull();

      unlinkSync(codexFile);
      expect(await scanner.refreshFile(codexFile)).toBeNull();
      expect(await scanner.getConversation("sess-basic-0001")).toBeNull();
    });
  });
});
