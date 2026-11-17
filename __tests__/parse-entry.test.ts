import { readFileSync } from "fs";
import { join } from "path";
import * as root from "../src/index";
import * as parse from "../src/parse";

const lines = readFileSync(
  join(__dirname, "..", "__fixtures__", "parse-entry-conversation.jsonl"),
  "utf-8",
).split("\n");

function run(entry: typeof root | typeof parse) {
  const state = entry.createJsonlParseState();
  return lines.map((line) => entry.parseJsonlLine(line, state));
}

describe("@threadbase-sh/scanner/parse entry", () => {
  it("parses a conversation exactly like the root entry", () => {
    const viaParse = run(parse);
    expect(viaParse).toEqual(run(root));
    expect(viaParse.filter(Boolean).length).toBeGreaterThan(0);
  });

  it("pairs the tool_result with its tool_use through the shared state", () => {
    const messages = run(parse).filter((m) => m !== null);
    const result = messages.flatMap((m) => m.metadata?.toolResults ?? [])[0];
    expect(result).toMatchObject({ toolUseId: "tu1", type: "bash" });
    expect(messages.some((m) => m.thinkingContent)).toBe(true);
  });

  it("skips the isMeta row", () => {
    const metaIndex = lines.findIndex((l) => l.includes('"isMeta":true'));
    expect(metaIndex).toBeGreaterThan(-1);
    expect(run(parse)[metaIndex]).toBeNull();
  });

  it("classifies lines with a fresh state each, but cannot pair the result", () => {
    const messages = lines.map((line) => parse.parseJsonlLine(line, parse.createJsonlParseState()));
    expect(messages).toHaveLength(lines.length);
    const shared = run(parse);
    expect(messages.map((m) => m === null)).toEqual(shared.map((m) => m === null));
    const result = messages.flatMap((m) => m?.metadata?.toolResults ?? [])[0];
    expect(result).toMatchObject({ toolUseId: "tu1", type: "generic" });
  });

  it("exports cleanSystemTags", () => {
    expect(parse.cleanSystemTags).toBe(root.cleanSystemTags);
  });
});
