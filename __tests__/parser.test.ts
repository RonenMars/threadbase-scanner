import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseConversation, parseMeta } from "../src/parser";

const FIXTURES = join(__dirname, "..", "__fixtures__");
const TIER_STD = { name: "standard", previewMax: 200, snippetMax: 5000 };

describe("parseMeta", () => {
  it("extracts all metadata fields from valid conversation", async () => {
    const meta = await parseMeta(join(FIXTURES, "valid-conversation.jsonl"), "default", TIER_STD);
    expect(meta).not.toBeNull();
    expect(meta?.sessionId).toBe("sess-abc");
    expect(meta?.sessionName).toBe("my-session");
  });

  it("falls back sessionName to the first user message's first line when no slug", async () => {
    const meta = await parseMeta(join(FIXTURES, "no-slug-conversation.jsonl"), "default", TIER_STD);
    expect(meta?.sessionName).toBe("Fix the failing login test");
    expect(meta?.projectPath).toBe("/home/user/project");
  });

  it("detects teammate from first user message", async () => {
    const meta = await parseMeta(
      join(FIXTURES, "teammate-conversation.jsonl"),
      "default",
      TIER_STD,
    );
    expect(meta).not.toBeNull();
    expect(meta?.isTeammate).toBe(true);
    expect(meta?.teamName).toBe("backend-team");
  });

  it("collects tool names", async () => {
    const meta = await parseMeta(
      join(FIXTURES, "tool-use-conversation.jsonl"),
      "default",
      TIER_STD,
    );
    expect(meta).not.toBeNull();
    expect(meta?.toolNames).toContain("Read");
    expect(meta?.toolNames).toContain("Grep");
  });

  it("returns null for empty file", async () => {
    const meta = await parseMeta(join(FIXTURES, "empty.jsonl"), "default", TIER_STD);
    expect(meta).toBeNull();
  });

  it("skips malformed lines and parses valid ones", async () => {
    const meta = await parseMeta(join(FIXTURES, "malformed.jsonl"), "default", TIER_STD);
    expect(meta).not.toBeNull();
    expect(meta?.messageCount).toBe(1);
  });

  it("respects preview and snippet limits", async () => {
    const meta = await parseMeta(join(FIXTURES, "valid-conversation.jsonl"), "default", {
      name: "tiny",
      previewMax: 10,
      snippetMax: 20,
    });
    expect(meta).not.toBeNull();
    expect(meta?.preview.length).toBeLessThanOrEqual(10);
    expect(meta?.contentSnippet.length).toBeLessThanOrEqual(20);
  });

  it("extracts lastPrompt from last-prompt entry", async () => {
    const meta = await parseMeta(
      join(FIXTURES, "last-prompt-conversation.jsonl"),
      "default",
      TIER_STD,
    );
    expect(meta).not.toBeNull();
    expect(meta?.lastPrompt).toBe("Fix the bug in main.ts");
  });

  it("does not count last-prompt entry as a message", async () => {
    const meta = await parseMeta(
      join(FIXTURES, "last-prompt-conversation.jsonl"),
      "default",
      TIER_STD,
    );
    expect(meta).not.toBeNull();
    expect(meta?.messageCount).toBe(4);
  });

  it("lastPrompt is undefined when no last-prompt entry exists", async () => {
    const meta = await parseMeta(join(FIXTURES, "valid-conversation.jsonl"), "default", TIER_STD);
    expect(meta).not.toBeNull();
    expect(meta?.lastPrompt).toBeUndefined();
  });
});

describe("parseConversation", () => {
  it("parses full conversation with messages", async () => {
    const conv = await parseConversation(join(FIXTURES, "valid-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    expect(conv?.messages).toHaveLength(4);
    expect(conv?.sessionId).toBe("sess-abc");
    expect(conv?.messages[0].role).toBe("user");
    expect(conv?.messages[0].text).toContain("Hello");
    expect(conv?.messages[1].role).toBe("assistant");
    expect(conv?.messages[1].metadata?.model).toBe("claude-sonnet-4-20250514");
  });

  it("returns null for empty file", async () => {
    const conv = await parseConversation(join(FIXTURES, "empty.jsonl"), "default");
    expect(conv).toBeNull();
  });

  it("falls back sessionName to the first user message when no slug", async () => {
    const conv = await parseConversation(join(FIXTURES, "no-slug-conversation.jsonl"), "default");
    expect(conv?.sessionName).toBe("Fix the failing login test");
  });
});

describe("tool_result is_error extraction", () => {
  it("populates toolResults with isError: false on successful tool results", async () => {
    const conv = await parseConversation(join(FIXTURES, "tool-use-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const toolResultMsg = conv?.messages.find((m) => m.isToolResult && m.metadata?.toolResults);
    expect(toolResultMsg).toBeDefined();
    const result = toolResultMsg?.metadata?.toolResults?.[0];
    expect(result.isError).toBe(false);
    expect(result.toolUseId).toBe("tu1");
    expect(result.type).toBe("read");
  });

  it("captures is_error: true on errored tool results", async () => {
    const conv = await parseConversation(join(FIXTURES, "tool-use-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const errorMsg = conv?.messages.find(
      (m) => m.isToolResult && m.metadata?.toolResults?.[0]?.isError === true,
    );
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.metadata?.toolResults?.[0].type).toBe("bash");
  });

  it("classifies tool result type from pending tool name", async () => {
    const conv = await parseConversation(join(FIXTURES, "tool-use-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const readResult = conv?.messages.find(
      (m) => m.isToolResult && m.metadata?.toolResults?.[0]?.toolUseId === "tu1",
    );
    expect(readResult?.metadata?.toolResults?.[0].type).toBe("read");
  });
});

describe("conversation graph fields (parentUuid, requestId, promptId, isSidechain, permissionMode)", () => {
  it("extracts parentUuid as null on first entry", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    expect(conv?.messages[0].parentUuid).toBeNull();
  });

  it("extracts parentUuid as uuid string on subsequent entries", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    expect(conv?.messages[1].parentUuid).toBe("u1");
  });

  it("extracts requestId only on assistant entries", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const userMsg = conv?.messages.find((m) => m.role === "user");
    expect(userMsg?.requestId).toBeUndefined();
    const assistantMsg = conv?.messages.find((m) => m.role === "assistant" && m.text);
    expect(assistantMsg?.requestId).toBe("req_01abc");
  });

  it("requestId is shared across streaming chunks from the same API call", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const assistantMsgs = conv?.messages.filter((m) => m.role === "assistant");
    const requestIds = assistantMsgs.map((m) => m.requestId).filter(Boolean);
    expect(new Set(requestIds).size).toBe(1);
    expect(requestIds[0]).toBe("req_01abc");
  });

  it("extracts promptId only on user entries", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const userMsgs = conv?.messages.filter((m) => m.role === "user");
    for (const msg of userMsgs) {
      expect(msg.promptId).toBe("pid-1");
    }
    const assistantMsg = conv?.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.promptId).toBeUndefined();
  });

  it("promptId is shared between prompt and its tool-result reply", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const userMsgs = conv?.messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0].promptId).toBe("pid-1");
    expect(userMsgs[1].promptId).toBe("pid-1");
  });

  it("extracts isSidechain as false on normal conversation entries", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    for (const msg of conv?.messages ?? []) {
      expect(msg.isSidechain).toBe(false);
    }
  });

  it("extracts permissionMode on user entries only", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const userMsgs = conv?.messages.filter((m) => m.role === "user");
    for (const msg of userMsgs) {
      expect(msg.permissionMode).toBe("default");
    }
    const assistantMsgs = conv?.messages.filter((m) => m.role === "assistant");
    for (const msg of assistantMsgs) {
      expect(msg.permissionMode).toBeUndefined();
    }
  });
});

describe("thinking block signature extraction", () => {
  it("extracts thinkingSignature even when thinking text is empty (redacted)", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const thinkingMsg = conv?.messages.find((m) => m.isThinking);
    expect(thinkingMsg).toBeDefined();
    expect(thinkingMsg?.thinkingSignature).toBe("EoMCClsIDBgC...");
    expect(thinkingMsg?.thinkingContent).toBeUndefined();
  });

  it("sets isThinking: true when only signature is present (redacted thinking)", async () => {
    const conv = await parseConversation(join(FIXTURES, "streaming-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const thinkingMsg = conv?.messages.find((m) => m.isThinking);
    expect(thinkingMsg).toBeDefined();
    expect(thinkingMsg?.isThinking).toBe(true);
  });
});

describe("image block detection", () => {
  it("sets hasImages: true for source.base64 image blocks", async () => {
    const conv = await parseConversation(join(FIXTURES, "image-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const sourceImageMsg = conv?.messages.find((m) => m.uuid === "i1");
    expect(sourceImageMsg).toBeDefined();
    expect(sourceImageMsg?.hasImages).toBe(true);
  });

  it("sets hasImages: true for file.base64 image blocks", async () => {
    const conv = await parseConversation(join(FIXTURES, "image-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const fileImageMsg = conv?.messages.find((m) => m.uuid === "i3");
    expect(fileImageMsg).toBeDefined();
    expect(fileImageMsg?.hasImages).toBe(true);
  });

  it("does not set hasImages on messages with no image blocks", async () => {
    const conv = await parseConversation(join(FIXTURES, "image-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    const textOnlyMsg = conv?.messages.find((m) => m.uuid === "i2");
    expect(textOnlyMsg).toBeDefined();
    expect(textOnlyMsg?.hasImages).toBeUndefined();
  });
});

describe("attachment sidecar field", () => {
  it("extracts attachment from entries that have one", async () => {
    const conv = await parseConversation(
      join(FIXTURES, "attachment-conversation.jsonl"),
      "default",
    );
    expect(conv).not.toBeNull();
    const msgWithAttachment = conv?.messages.find((m) => m.attachment !== undefined);
    expect(msgWithAttachment).toBeDefined();
    expect(msgWithAttachment?.attachment?.type).toBe("deferred_tools_delta");
  });

  it("extracts addedNames from deferred_tools_delta attachment", async () => {
    const conv = await parseConversation(
      join(FIXTURES, "attachment-conversation.jsonl"),
      "default",
    );
    expect(conv).not.toBeNull();
    const msg = conv?.messages.find((m) => m.attachment?.type === "deferred_tools_delta");
    const attachment = msg?.attachment as { type: string; addedNames: string[] };
    expect(attachment.addedNames).toContain("AskUserQuestion");
    expect(attachment.addedNames).toContain("CronCreate");
  });

  it("attachment is undefined on entries without an attachment field", async () => {
    const conv = await parseConversation(
      join(FIXTURES, "attachment-conversation.jsonl"),
      "default",
    );
    expect(conv).not.toBeNull();
    const assistantMsg = conv?.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg?.attachment).toBeUndefined();
  });
});

describe("system entry handling", () => {
  it("extracts turn_duration into Conversation.turnDurations", async () => {
    const conv = await parseConversation(
      join(FIXTURES, "system-entries-conversation.jsonl"),
      "default",
    );
    expect(conv).not.toBeNull();
    expect(conv?.turnDurations).toBeDefined();
    expect(conv?.turnDurations).toHaveLength(1);
    expect(conv?.turnDurations?.[0].durationMs).toBe(5432);
    expect(conv?.turnDurations?.[0].messageCount).toBe(2);
  });

  it("does not create ConversationMessages for system entries", async () => {
    const conv = await parseConversation(
      join(FIXTURES, "system-entries-conversation.jsonl"),
      "default",
    );
    expect(conv).not.toBeNull();
    // Only user + assistant entries become messages; system entries are excluded
    expect(conv?.messages).toHaveLength(2);
    for (const msg of conv?.messages ?? []) {
      expect(["user", "assistant"]).toContain(msg.role);
    }
  });

  it("ignores stop_hook_summary system entries (does not add to turnDurations)", async () => {
    const conv = await parseConversation(
      join(FIXTURES, "system-entries-conversation.jsonl"),
      "default",
    );
    expect(conv).not.toBeNull();
    // Only 1 turn_duration entry, stop_hook_summary is ignored
    expect(conv?.turnDurations).toHaveLength(1);
  });

  it("turnDurations is undefined when no system entries exist", async () => {
    const conv = await parseConversation(join(FIXTURES, "valid-conversation.jsonl"), "default");
    expect(conv).not.toBeNull();
    expect(conv?.turnDurations).toBeUndefined();
  });
});
