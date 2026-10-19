import { describe, expect, it } from "vitest";
import { firstUserTitle, foldClaudeTitle, resolveClaudeTitle, type ClaudeTitleState } from "../src/persistent/claude-title";
import { initialReducerState, reduceLine } from "../src/persistent/metadata-reducer";
import { initialConvState, reduceConvLine } from "../src/persistent/conversation-reducer";

const state = (): ClaudeTitleState => ({
  customTitle: "", aiTitle: "", lastPrompt: "", firstUserTitle: "", slug: "",
});

describe("Claude Code picker title precedence", () => {
  it("prefers custom title over AI title, last prompt, first message and slug", () => {
    const s = { ...state(), slug: "green-bouncy-goose", firstUserTitle: "Fix it", lastPrompt: "continue" };
    foldClaudeTitle(s, { type: "ai-title", aiTitle: "Fix authentication" });
    foldClaudeTitle(s, { type: "custom-title", customTitle: "AUTH-123" });
    foldClaudeTitle(s, { type: "ai-title", aiTitle: "Later AI title" });
    expect(resolveClaudeTitle(s)).toBe("AUTH-123");
  });
  it("last valid occurrence within a title type wins", () => {
    const s = state();
    foldClaudeTitle(s, { type: "custom-title", customTitle: "Original" });
    foldClaudeTitle(s, { type: "custom-title", customTitle: "Renamed" });
    foldClaudeTitle(s, { type: "custom-title", customTitle: " " });
    expect(resolveClaudeTitle(s)).toBe("Renamed");
  });
  it("uses last AI title, then last prompt, then user text, then slug", () => {
    const s = { ...state(), slug: "fallback-slug" };
    expect(resolveClaudeTitle(s)).toBe("fallback-slug");
    s.firstUserTitle = "Investigate timeout";
    expect(resolveClaudeTitle(s)).toBe("Investigate timeout");
    s.lastPrompt = "continue";
    expect(resolveClaudeTitle(s)).toBe("continue");
    foldClaudeTitle(s, { type: "ai-title", aiTitle: "Investigate request timeout" });
    foldClaudeTitle(s, { type: "ai-title", aiTitle: "Resolve request timeout" });
    expect(resolveClaudeTitle(s)).toBe("Resolve request timeout");
  });
  it("extracts /model while removing command metadata tags", () => {
    const input = "<command-name>/model</command-name><command-message>model</command-message>";
    expect(firstUserTitle("", input)).toBe("/model");
    expect(firstUserTitle("Fix auth", input)).toBe("Fix auth");
  });
  it("shares the same first-user and latest-prompt extraction in both reducers", () => {
    const metadata = initialReducerState();
    const conversation = initialConvState();
    const rows = [
      { type: "user", message: { content: [{ type: "tool_result", content: "not a prompt" }] }, toolUseResult: {} },
      { type: "user", message: { content: "<command-name>/model</command-name><command-message>model</command-message>" } },
      { type: "last-prompt", lastPrompt: "continue" },
      { type: "last-prompt", lastPrompt: "Another Claude session sent a message" },
    ];
    for (const row of rows) {
      reduceLine(metadata, row, { name: "test", previewMax: 200, snippetMax: 200 } as Parameters<typeof reduceLine>[2]);
      reduceConvLine(conversation, row);
    }
    expect(metadata.firstUserTitle).toBe("/model");
    expect(conversation.firstUserTitle).toBe("/model");
    expect(resolveClaudeTitle(metadata)).toBe("Another Claude session sent a message");
    expect(resolveClaudeTitle(conversation)).toBe(resolveClaudeTitle(metadata));
  });

  it("folds identical title metadata in the indexed and conversation reducers", () => {
    const metadata = initialReducerState();
    const conversation = initialConvState();
    const rows = [
      { type: "user", sessionId: "abc", slug: "blue-panda", message: { content: "First request" }, timestamp: "2026-10-18T12:00:00Z" },
      { type: "last-prompt", lastPrompt: "continue" },
      { type: "last-prompt", lastPrompt: "Another Claude session sent a message" },
      { type: "ai-title", aiTitle: "Initial summary" },
      { type: "ai-title", aiTitle: "Updated summary" },
      { type: "custom-title", customTitle: "Custom name" },
    ];
    for (const entry of rows) {
      reduceLine(metadata, entry, { name: "test", previewMax: 200, snippetMax: 200 } as Parameters<typeof reduceLine>[2]);
      reduceConvLine(conversation, entry);
    }
    expect(resolveClaudeTitle(metadata)).toBe("Custom name");
    expect(resolveClaudeTitle(conversation)).toBe("Custom name");
    expect(metadata.lastPrompt).toBe("Another Claude session sent a message");
    expect(conversation.lastPrompt).toBe(metadata.lastPrompt);
  });
});
