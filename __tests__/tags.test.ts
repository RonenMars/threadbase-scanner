import { describe, expect, it } from "vitest";
import { deriveSessionNameFromFirstMessage } from "../src/persistent/metadata-reducer";
import { cleanSystemTags } from "../src/tags";

describe("cleanSystemTags", () => {
  it("removes system-reminder tags", () => {
    const input = "Hello <system-reminder>some reminder</system-reminder> world";
    expect(cleanSystemTags(input)).toBe("Hello world");
  });

  it("removes thinking tags", () => {
    const input = "Before <thinking>internal thoughts</thinking> after";
    expect(cleanSystemTags(input)).toBe("Before after");
  });

  it("removes multiple different tags", () => {
    const input = "<command-name>test</command-name> Hello <fast_mode_info>info</fast_mode_info>";
    expect(cleanSystemTags(input)).toBe("Hello");
  });

  it("handles multiline tag content", () => {
    const input = "Start <system-reminder>\nline1\nline2\n</system-reminder> end";
    expect(cleanSystemTags(input)).toBe("Start end");
  });

  it("collapses whitespace", () => {
    const input = "Hello    world   here";
    expect(cleanSystemTags(input)).toBe("Hello world here");
  });

  it("limits consecutive blank lines to 2", () => {
    const input = "line1\n\n\n\n\nline2";
    expect(cleanSystemTags(input)).toBe("line1\n\nline2");
  });

  it("returns empty string for all-tag input", () => {
    const input = "<system-reminder>only tags</system-reminder>";
    expect(cleanSystemTags(input)).toBe("");
  });

  it("removes all known tag types", () => {
    const tags = [
      "system-reminder",
      "command-name",
      "command-message",
      "command-args",
      "ide_selection",
      "ide_opened_file",
      "local-command-stdout",
      "local-command-caveat",
      "retrieval_status",
      "task_id",
      "task_type",
      "task-id",
      "task-notification",
      "fast_mode_info",
      "persisted-output",
      "tool_use_error",
      "user-prompt-submit-hook",
      "thinking",
      "ask_user",
      "teammate-message",
    ];
    for (const tag of tags) {
      const input = `before <${tag}>content</${tag}> after`;
      expect(cleanSystemTags(input)).toBe("before after");
    }
  });

  it("unwraps a pasted_content block, keeping the inner text", () => {
    const input =
      '\n\n<pasted_content id="d4a7">\nThis is a test. Count the amount of the folders in this folder.\n</pasted_content id="d4a7">\n';
    expect(cleanSystemTags(input)).toBe(
      "This is a test. Count the amount of the folders in this folder.",
    );
  });

  it("unwraps a pasted_content block whose closing tag has no attribute", () => {
    const input = '<pasted_content id="ab12">kept text</pasted_content>';
    expect(cleanSystemTags(input)).toBe("kept text");
  });

  it("leaves text that merely mentions pasted_content with no matching pair", () => {
    const input = "talking about pasted_content tags in general";
    expect(cleanSystemTags(input)).toBe(input);
  });

  it("keeps every line of a multiline paste", () => {
    const input = '<pasted_content id="ab12">line1\nline2\nline3</pasted_content id="ab12">';
    expect(cleanSystemTags(input)).toBe("line1\nline2\nline3");
  });

  it("removes a system-reminder and keeps a pasted block in the same message", () => {
    const input =
      '<system-reminder>ignore me</system-reminder>\n<pasted_content id="ab12">keep me</pasted_content id="ab12">';
    expect(cleanSystemTags(input)).toBe("keep me");
  });

  it("derives the session title from the pasted sentence, not the tag", () => {
    const raw =
      '\n\n<pasted_content id="d4a7">\nThis is a test. Count the amount of the folders in this folder.\n</pasted_content id="d4a7">\n';
    const cleaned = cleanSystemTags(raw);
    expect(deriveSessionNameFromFirstMessage({ text: cleaned })).toBe(
      "This is a test. Count the amount of the folders in this folder.",
    );
  });
});
