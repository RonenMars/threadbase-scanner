import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";

const FIXTURES = join(__dirname, "..", "__fixtures__", "cursor");

function cursorTurn(text: string): string {
  return `${JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: `<user_query>\n${text}\n</user_query>` }] },
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

describe("provider resolution on the Cursor single-file paths", () => {
  let dir: string;
  let cursorFile: string;
  let claudeFile: string;
  let scanner: ConversationScanner;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-cursor-single-"));
    const sessionDir = join(dir, "Users-dev-widget", "agent-transcripts", "sess-basic-0001");
    mkdirSync(sessionDir, { recursive: true });
    cursorFile = join(sessionDir, "sess-basic-0001.jsonl");
    copyFileSync(join(FIXTURES, "basic-session.jsonl"), cursorFile);

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
    it("parses a Cursor transcript instead of returning null", async () => {
      const page = await scanner.parseSingleFilePage(cursorFile, "cursor", { limit: 10 });
      expect(page).not.toBeNull();
      expect(page?.total).toBe(4);
      expect(page?.messages[0]?.text).toBe("How do I reverse a list in Python?");
    });

    it("pages a Cursor transcript that grew, from the new end", async () => {
      appendFileSync(cursorFile, cursorTurn("and to reverse a string?"));
      const page = await scanner.parseSingleFilePage(cursorFile, "cursor", { limit: 1 });
      expect(page?.total).toBe(5);
      expect(page?.fromIndex).toBe(4);
      expect(page?.messages.map((m) => m.text)).toEqual(["and to reverse a string?"]);
    });

    it("still parses a Claude transcript", async () => {
      const page = await scanner.parseSingleFilePage(claudeFile, "default", { limit: 10 });
      expect(page?.total).toBe(1);
      expect(page?.messages[0]?.text).toBe("first");
    });
  });

  describe("refreshFile (non-persistent)", () => {
    it("keeps a Cursor transcript indexed instead of dropping it", async () => {
      await scanner.scan({ profiles: [], providers: ["cursor"], cursorRoots: [dir] });
      expect((await scanner.getConversation("sess-basic-0001"))?.messages).toHaveLength(4);

      appendFileSync(cursorFile, cursorTurn("and to reverse a string?"));
      const meta = await scanner.refreshFile(cursorFile);

      expect(meta).not.toBeNull();
      expect(meta?.provider).toBe("cursor");
      expect(meta?.messageCount).toBe(5);
      expect((await scanner.getConversation("sess-basic-0001"))?.messages).toHaveLength(5);
    });

    it("still drops a Cursor transcript that was deleted", async () => {
      await scanner.scan({ profiles: [], providers: ["cursor"], cursorRoots: [dir] });
      expect(await scanner.getConversation("sess-basic-0001")).not.toBeNull();

      unlinkSync(cursorFile);
      expect(await scanner.refreshFile(cursorFile)).toBeNull();
      expect(await scanner.getConversation("sess-basic-0001")).toBeNull();
    });
  });
});
