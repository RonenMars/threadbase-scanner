// `parseCodexJsonlLine` is documented as the public per-line mapping "for
// downstream indexers tailing appended lines". Such an indexer numbers messages
// itself, so it needs the same injected-context decision this package applies
// internally in reduceCodexEntry — otherwise its index counts in a different
// space than a consumer that renders from the same file.
import { isCodexInjectedContext, parseCodexJsonlLine } from "../src/index";

describe("isCodexInjectedContext is part of the public surface", () => {
  it("recognises the Codex preambles that reduceCodexEntry skips", () => {
    expect(isCodexInjectedContext("# AGENTS.md\n\nproject instructions")).toBe(true);
    expect(isCodexInjectedContext("<permissions instructions>sandbox")).toBe(true);
    expect(isCodexInjectedContext("something\n<INSTRUCTIONS>\nmore")).toBe(true);
    expect(isCodexInjectedContext("Filesystem sandboxing defines what you may touch")).toBe(true);
  });

  it("leaves an ordinary turn alone", () => {
    expect(isCodexInjectedContext("please refactor the parser")).toBe(false);
    expect(isCodexInjectedContext("")).toBe(false);
  });

  it("pairs with parseCodexJsonlLine, which deliberately does not apply it", () => {
    // The line parser is stateless, so it cannot know whether a line is the
    // LEADING turn — the bound reduceCodexEntry applies. Callers that know the
    // position apply the predicate themselves; this test pins that contract so
    // the two do not silently diverge.
    const line = JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-10T00:00:00Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md\n\nproject instructions" }],
      },
    });
    const parsed = parseCodexJsonlLine(line);
    expect(parsed).not.toBeNull();
    expect(isCodexInjectedContext(parsed?.text ?? "")).toBe(true);
  });
});
