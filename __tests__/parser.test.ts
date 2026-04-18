import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseConversation, parseMeta } from "../src/parser";

const FIXTURES = join(__dirname, "..", "__fixtures__");

describe("parseMeta", () => {
  it("extracts all metadata fields from valid conversation", async () => {
    const meta = await parseMeta(join(FIXTURES, "valid-conversation.jsonl"), "default", {
      name: "standard",
      previewMax: 200,
      snippetMax: 5000,
    });
    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe("sess-abc");
    expect(meta!.sessionName).toBe("my-session");
    expect(meta!.projectPath).toBe("/home/user/project");
    expect(meta!.messageCount).toBe(4);
    expect(meta!.lastMessageSender).toBe("assistant");
    expect(meta!.timestamp).toBe("2026-01-15T10:01:30.000Z");
    expect(meta!.preview).toContain("Hello");
    expect(meta!.model).toBe("claude-sonnet-4-20250514");
    expect(meta!.toolNames).toContain("Edit");
    expect(meta!.isSubagent).toBe(false);
    expect(meta!.isTeammate).toBe(false);
  });

  it("detects teammate from first user message", async () => {
    const meta = await parseMeta(join(FIXTURES, "teammate-conversation.jsonl"), "default", {
      name: "standard",
      previewMax: 200,
      snippetMax: 5000,
    });
    expect(meta).not.toBeNull();
    expect(meta!.isTeammate).toBe(true);
    expect(meta!.teamName).toBe("backend-team");
  });

  it("collects tool names", async () => {
    const meta = await parseMeta(join(FIXTURES, "tool-use-conversation.jsonl"), "default", {
      name: "standard",
      previewMax: 200,
      snippetMax: 5000,
    });
    expect(meta).not.toBeNull();
    expect(meta!.toolNames).toContain("Read");
    expect(meta!.toolNames).toContain("Grep");
  });

  it("returns null for empty file", async () => {
    const meta = await parseMeta(join(FIXTURES, "empty.jsonl"), "default", {
      name: "standard",
      previewMax: 200,
      snippetMax: 5000,
    });
    expect(meta).toBeNull();
  });

  it("skips malformed lines and parses valid ones", async () => {
    const meta = await parseMeta(join(FIXTURES, "malformed.jsonl"), "default", {
      name: "standard",
      previewMax: 200,
      snippetMax: 5000,
    });
    expect(meta).not.toBeNull();
    expect(meta!.messageCount).toBe(1);
  });

  it("respects preview and snippet limits", async () => {
    const meta = await parseMeta(join(FIXTURES, "valid-conversation.jsonl"), "default", {
      name: "tiny",
      previewMax: 10,
      snippetMax: 20,
    });
    expect(meta).not.toBeNull();
    expect(meta!.preview.length).toBeLessThanOrEqual(10);
    expect(meta!.contentSnippet.length).toBeLessThanOrEqual(20);
  });
});

describe("parseConversation", () => {
  it("parses full conversation with messages", async () => {
    const conv = await parseConversation(join(FIXTURES, "valid-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    expect(conv!.messages).toHaveLength(4);
    expect(conv!.sessionId).toBe("sess-abc");
    expect(conv!.messages[0].role).toBe("user");
    expect(conv!.messages[0].text).toContain("Hello");
    expect(conv!.messages[1].role).toBe("assistant");
    expect(conv!.messages[1].metadata?.model).toBe("claude-sonnet-4-20250514");
  });

  it("returns null for empty file", async () => {
    const conv = await parseConversation(join(FIXTURES, "empty.jsonl"), "default");
    expect(conv).toBeNull();
  });
});
