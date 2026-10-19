import { describe, expect, it } from "vitest";
import {
  applyNameCandidate,
  isValidNameCandidate,
  NAME_PRECEDENCE,
  type NameSlot,
  type NameSlots,
  resolveSessionName,
} from "../src/session-name";

// Folds candidates in order through the single write path, like a reducer would.
function fold(
  candidates: Array<[NameSlot, string | undefined]>,
  provider: Parameters<typeof applyNameCandidate>[3] = "claude-code",
): NameSlots {
  return candidates.reduce<NameSlots>(
    (slots, [slot, raw]) => applyNameCandidate(slots, slot, raw, provider),
    {},
  );
}

describe("resolveSessionName", () => {
  it("exposes the approved precedence, highest first", () => {
    expect(NAME_PRECEDENCE).toEqual([
      "userTitle",
      "toolTitle",
      "lastPrompt",
      "firstUserMessage",
      "slug",
    ]);
  });

  it("returns null when no slot holds a value", () => {
    expect(resolveSessionName({})).toEqual({ name: null, source: null });
  });

  it("ignores empty and whitespace-only slots", () => {
    expect(resolveSessionName({ userTitle: "", toolTitle: "  ", slug: "brave-otter" })).toEqual({
      name: "brave-otter",
      source: "slug",
    });
  });

  it.each(NAME_PRECEDENCE.map((slot, i) => [slot, NAME_PRECEDENCE.slice(i)] as const))(
    "%s beats every slot below it",
    (slot, slotsFromHere) => {
      const slots: NameSlots = Object.fromEntries(slotsFromHere.map((s) => [s, `value-${s}`]));
      expect(resolveSessionName(slots)).toEqual({ name: `value-${slot}`, source: slot });
    },
  );

  it("does not mutate its input", () => {
    const slots: NameSlots = Object.freeze({ toolTitle: "t" });
    expect(() => resolveSessionName(slots)).not.toThrow();
  });
});

describe("applyNameCandidate", () => {
  it("returns a new object and leaves the input untouched", () => {
    const before: NameSlots = Object.freeze({ toolTitle: "a" });
    const after = applyNameCandidate(before, "toolTitle", "b", "claude-code");
    expect(after).toEqual({ toolTitle: "b" });
    expect(before).toEqual({ toolTitle: "a" });
  });

  it("last valid occurrence wins within a slot", () => {
    const slots = fold([
      ["toolTitle", "first"],
      ["toolTitle", "second"],
    ]);
    expect(resolveSessionName(slots)).toEqual({ name: "second", source: "toolTitle" });
  });

  it("firstUserMessage keeps the first valid occurrence and is never replaced", () => {
    const slots = fold([
      ["firstUserMessage", "Fix the login bug"],
      ["firstUserMessage", "Now something else"],
    ]);
    expect(slots.firstUserMessage).toBe("Fix the login bug");
  });

  it("firstUserMessage skips invalid candidates until a valid one arrives", () => {
    const slots = fold([
      ["firstUserMessage", "<command-name>/model</command-name>"],
      ["firstUserMessage", "Fix the login bug"],
    ]);
    expect(slots.firstUserMessage).toBe("Fix the login bug");
  });

  it("an invalid candidate never overwrites a valid value in its slot", () => {
    const slots = fold([
      ["lastPrompt", "continue"],
      ["lastPrompt", "Another Claude session sent a message: <teammate-message x>"],
      ["lastPrompt", "   "],
      ["lastPrompt", undefined],
    ]);
    expect(slots.lastPrompt).toBe("continue");
  });

  it("a higher slot wins regardless of the order candidates arrive", () => {
    const aiThenCustom = fold([
      ["toolTitle", "AI title"],
      ["userTitle", "My title"],
      ["toolTitle", "Later AI title"],
    ]);
    expect(resolveSessionName(aiThenCustom)).toEqual({ name: "My title", source: "userTitle" });
  });

  it("slug is only a fallback", () => {
    const slots = fold([
      ["slug", "brave-otter"],
      ["toolTitle", "Typing test"],
    ]);
    expect(resolveSessionName(slots)).toEqual({ name: "Typing test", source: "toolTitle" });
  });

  it("keeps the full text: no first-line cut, no 80-character limit", () => {
    const text = [
      `first ${"a".repeat(190)}`,
      `second ${"b".repeat(192)}`,
      `third ${"c".repeat(197)}`,
    ].join("\n");
    expect(text).toHaveLength(600);
    const slots = fold([["firstUserMessage", text]]);
    expect(slots.firstUserMessage).toBe(text);
  });

  it("stores the cleaned text, unwrapping pasted_content", () => {
    const slots = fold([
      [
        "firstUserMessage",
        '<pasted_content id="ab12">Refactor the parser</pasted_content id="ab12">',
      ],
    ]);
    expect(slots.firstUserMessage).toBe("Refactor the parser");
  });
});

describe("isValidNameCandidate", () => {
  describe("shared", () => {
    it.each(["", "   ", "\n\t"])("rejects empty text %j", (text) => {
      expect(isValidNameCandidate(text, "claude-code")).toBe(false);
    });

    it("rejects text that is empty once system tags are cleaned", () => {
      expect(isValidNameCandidate("<thinking>hmm</thinking>", "copilot")).toBe(false);
    });

    it("accepts ordinary text for every provider", () => {
      for (const p of ["claude-code", "codex-cli", "cursor", "copilot"] as const) {
        expect(isValidNameCandidate("Fix the login bug", p)).toBe(true);
      }
    });
  });

  describe("claude-code", () => {
    it.each([
      "<command-name>/model</command-name>",
      "<command-message>model</command-message>",
      "<command-args>x</command-args>",
      "<local-command-stdout>ok</local-command-stdout>",
      "<local-command-stderr>no</local-command-stderr>",
      "<local-command-caveat>Caveat</local-command-caveat>",
      "<bash-input>ls</bash-input>",
      "<bash-stdout>a</bash-stdout>",
      "<bash-stderr>b</bash-stderr>",
      "<system-reminder>r</system-reminder>",
      "<task-notification>done</task-notification>",
      '<teammate-message teammate_id="x">hi</teammate-message>',
      "Another Claude session sent a message: <teammate-message x>",
      "[Request interrupted by user for tool use]",
      "  [Request interrupted by user]",
    ])("rejects %j", (text) => {
      expect(isValidNameCandidate(text, "claude-code")).toBe(false);
    });

    it("accepts a normal prompt that merely mentions a tag later in the text", () => {
      expect(
        isValidNameCandidate("Why does <command-name> show up in titles?", "claude-code"),
      ).toBe(true);
    });
  });

  describe("codex-cli", () => {
    it.each([
      "<environment_context>\n<cwd>/x</cwd>\n</environment_context>",
      "# AGENTS.md instructions for /repo",
      "<user_instructions>do x</user_instructions>",
      "<INSTRUCTIONS>do x</INSTRUCTIONS>",
      "<external_codex_apps_open>",
      "<user_shell_command>ls</user_shell_command>",
      "<turn_aborted>x</turn_aborted>",
      "<permissions instructions>sandbox</permissions instructions>",
      "Use these.\nFilesystem sandboxing defines what files can be read.",
    ])("rejects %j", (text) => {
      expect(isValidNameCandidate(text, "codex-cli")).toBe(false);
    });

    it("drops <image> parts and judges the remaining text", () => {
      expect(isValidNameCandidate('<image name="a.png"></image>', "codex-cli")).toBe(false);
      expect(
        isValidNameCandidate('<image name="a.png">\nUse sentry plugin\n</image>', "codex-cli"),
      ).toBe(true);
    });

    it("stores the text without the image parts", () => {
      const slots = applyNameCandidate(
        {},
        "firstUserMessage",
        '<image name="a.png"></image>\nUse sentry plugin',
        "codex-cli",
      );
      expect(slots.firstUserMessage).toBe("Use sentry plugin");
    });

    it("does not apply the Codex rules to other providers", () => {
      expect(
        isValidNameCandidate("<environment_context>x</environment_context>", "claude-code"),
      ).toBe(true);
    });
  });

  describe("cursor and copilot", () => {
    // ponytail: the `<user_query>` extraction stays in the Cursor provider (the
    // slot-2 titles are not wrapped in it, and this function has no slot), so the
    // shared filter only applies the generic checks to Cursor and Copilot text.
    it("applies only the generic checks", () => {
      expect(isValidNameCandidate("Playwright Flow", "cursor")).toBe(true);
      expect(isValidNameCandidate("How should I build the extension?", "copilot")).toBe(true);
      expect(isValidNameCandidate("   ", "cursor")).toBe(false);
    });
  });
});
