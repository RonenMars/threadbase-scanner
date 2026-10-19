import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseConversation, parseMeta } from "../src/parser";
import { initialConvState, reduceConvLine } from "../src/persistent/conversation-reducer";
import { initialReducerState, reduceLine } from "../src/persistent/metadata-reducer";
import { type NameSlot, resolveSessionName } from "../src/session-name";

const DIR = join(__dirname, "..", "__fixtures__", "session-name");
const TIER = { name: "standard", previewMax: 200, snippetMax: 5000 };
const LONG = [
  `first ${"a".repeat(190)}`,
  `second ${"b".repeat(192)}`,
  `third ${"c".repeat(197)}`,
].join("\n");

// [fixture, expected name, expected source] — the acceptance cases in the plan.
const CASES: Array<[string, string, NameSlot]> = [
  ["01-custom-before-ai", "My custom title", "userTitle"],
  ["02-two-ai-titles", "Second generated", "toolTitle"],
  ["03-ai-custom-ai", "My custom title", "userTitle"],
  ["04-last-prompt-skips-leaf-only", "continue", "lastPrompt"],
  ["05-last-prompt-teammate-falls-through", "Fix the login bug", "firstUserMessage"],
  ["06-skips-injected-user-entries", "Fix the login bug", "firstUserMessage"],
  ["07-only-commands-and-slug", "brave-otter", "slug"],
  ["08-slug-then-ai-title", "Typing test", "toolTitle"],
  ["09-long-multiline-first-message", LONG, "firstUserMessage"],
  ["10-pasted-content", "Refactor the parser", "firstUserMessage"],
];

const lines = (name: string) =>
  readFileSync(join(DIR, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// State is round-tripped through JSON between every line, as an incremental
// index resumes it from the database.
const resume = <T>(state: T): T => JSON.parse(JSON.stringify(state));

describe("Claude session name", () => {
  it.each(CASES)("%s", async (fixture, name, source) => {
    const file = join(DIR, `${fixture}.jsonl`);

    expect((await parseMeta(file, "default", TIER))?.sessionName).toBe(name);
    expect((await parseConversation(file, "default"))?.sessionName).toBe(name);

    let meta = initialReducerState();
    let conv = initialConvState();
    for (const entry of lines(fixture)) {
      reduceLine(meta, entry, TIER);
      meta = resume(meta);
      reduceConvLine(conv, entry);
      conv = resume(conv);
    }
    expect(resolveSessionName(meta.nameSlots)).toEqual({ name, source });
    expect(resolveSessionName(conv.nameSlots)).toEqual({ name, source });
  });

  it("stores a 600-character, three-line first message unchanged", () => {
    expect(LONG).toHaveLength(600);
  });
});
