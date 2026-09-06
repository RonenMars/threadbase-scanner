// parseCodexJsonlLine is the single definition of "which Codex rollout lines
// render as messages" — the streamer needs it to translate a line ordinal
// (session_meta.forked_from_ordinal_exclusive) into a message index. The
// equivalence test at the bottom is the one that matters: it is what stops the
// exported rule and parseCodexConversation's own counting from drifting apart.
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCodexConversation, parseCodexJsonlLine } from "../src/providers/codex-cli";

const line = (o: unknown): string => JSON.stringify(o);

const userLine = line({
  timestamp: "2026-06-18T17:23:01.000Z",
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
});
const assistantLine = line({
  timestamp: "2026-06-18T17:23:02.000Z",
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
});
const developerLine = line({
  timestamp: "2026-06-18T17:23:03.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "sandbox boilerplate" }],
  },
});
const systemTagOnlyLine = line({
  timestamp: "2026-06-18T17:23:04.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<system-reminder>be good</system-reminder>" }],
  },
});
const sessionMetaLine = line({
  timestamp: "2026-06-18T17:23:00.000Z",
  type: "session_meta",
  payload: { id: "sess-codex-0001", cwd: "/home/dev/widget" },
});
const eventMsgLine = line({
  timestamp: "2026-06-18T17:23:05.000Z",
  type: "event_msg",
  payload: { type: "agent_reasoning", text: "thinking" },
});
const functionCallLine = line({
  timestamp: "2026-06-18T17:23:06.000Z",
  type: "response_item",
  payload: { type: "function_call", name: "shell", arguments: "{}" },
});

describe("parseCodexJsonlLine", () => {
  it("parses a user message", () => {
    expect(parseCodexJsonlLine(userLine)).toEqual({
      role: "user",
      text: "hello",
      timestamp: "2026-06-18T17:23:01.000Z",
    });
  });

  it("parses an assistant message", () => {
    expect(parseCodexJsonlLine(assistantLine)).toEqual({
      role: "assistant",
      text: "hi",
      timestamp: "2026-06-18T17:23:02.000Z",
    });
  });

  it("drops a developer-role message", () => {
    expect(parseCodexJsonlLine(developerLine)).toBeNull();
  });

  it("drops a message whose whole body is a system tag", () => {
    expect(parseCodexJsonlLine(systemTagOnlyLine)).toBeNull();
  });

  it("drops session_meta", () => {
    expect(parseCodexJsonlLine(sessionMetaLine)).toBeNull();
  });

  it("drops event_msg", () => {
    expect(parseCodexJsonlLine(eventMsgLine)).toBeNull();
  });

  it("drops a tool call", () => {
    expect(parseCodexJsonlLine(functionCallLine)).toBeNull();
  });

  it("returns null on malformed input instead of throwing", () => {
    expect(() => parseCodexJsonlLine("not json at all")).not.toThrow();
    expect(parseCodexJsonlLine("not json at all")).toBeNull();
    expect(parseCodexJsonlLine("")).toBeNull();
    expect(parseCodexJsonlLine("{}")).toBeNull();
    expect(parseCodexJsonlLine(line({ type: "response_item" }))).toBeNull();
  });
});

describe("parseCodexJsonlLine / parseCodexConversation equivalence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-line-parser-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps over the lines to exactly the conversation's message list", async () => {
    const lines = [
      sessionMetaLine,
      userLine,
      developerLine,
      assistantLine,
      functionCallLine,
      systemTagOnlyLine,
      eventMsgLine,
      "not json at all",
      line({
        timestamp: "2026-06-18T17:23:07.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second turn" }],
        },
      }),
    ];
    const filePath = join(dir, "rollout-2026-06-18T17-23-00-sess.jsonl");
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const conversation = await parseCodexConversation(filePath, "codex");
    const perLine = lines.map(parseCodexJsonlLine).filter((m) => m !== null);

    expect(conversation).not.toBeNull();
    expect(conversation?.messages).toEqual(perLine);
    expect(perLine).toHaveLength(3);
  });
});
