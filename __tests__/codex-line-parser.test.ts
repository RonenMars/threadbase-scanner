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
// Tool/reasoning fixtures keep every key a real Codex 0.15x rollout item carries
// (values shortened), so a parser keyed on a renamed field fails here.
const passthrough = { internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } };
const functionCallLine = line({
  timestamp: "2026-06-18T17:23:06.000Z",
  ordinal: 10,
  type: "response_item",
  payload: {
    type: "function_call",
    id: "fc_1",
    name: "exec_command",
    arguments: '{"cmd":"ls -la"}',
    call_id: "call_A",
    ...passthrough,
  },
});
const functionCallOutputLine = line({
  timestamp: "2026-06-18T17:23:06.500Z",
  ordinal: 11,
  type: "response_item",
  payload: {
    type: "function_call_output",
    id: "fco_1",
    call_id: "call_A",
    output: "Process exited with code 0\ntotal 0",
    ...passthrough,
  },
});
const customToolCallLine = line({
  timestamp: "2026-06-18T17:23:08.000Z",
  ordinal: 14,
  type: "response_item",
  payload: {
    type: "custom_tool_call",
    id: "ctc_1",
    status: "completed",
    call_id: "call_B",
    name: "exec",
    input: "const r = await tools.exec_command({cmd: 'pwd'})",
    ...passthrough,
  },
});
const customToolCallOutputLine = line({
  timestamp: "2026-06-18T17:23:08.500Z",
  ordinal: 16,
  type: "response_item",
  payload: {
    type: "custom_tool_call_output",
    id: "ctco_1",
    call_id: "call_B",
    output: [
      { type: "input_text", text: "Script completed" },
      { type: "input_text", text: "/home/dev/widget" },
    ],
    ...passthrough,
  },
});
const webSearchLine = line({
  timestamp: "2026-06-18T17:23:09.000Z",
  ordinal: 31,
  type: "response_item",
  payload: {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query: "codex config", queries: ["codex config"] },
    ...passthrough,
  },
});
const reasoningLine = (summary: unknown[]) =>
  line({
    timestamp: "2026-06-18T17:23:10.000Z",
    ordinal: 55,
    type: "response_item",
    payload: {
      type: "reasoning",
      id: "rs_1",
      summary,
      encrypted_content: "gAAAAABq",
      ...passthrough,
    },
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

  it("keys a message on its rollout item id", () => {
    const withId = line({
      timestamp: "2026-06-18T17:23:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    });
    expect(parseCodexJsonlLine(withId)?.uuid).toBe("msg_1");
  });

  it("parses a function call as a tool_use block with parsed arguments", () => {
    expect(parseCodexJsonlLine(functionCallLine)).toEqual({
      role: "assistant",
      text: "",
      timestamp: "2026-06-18T17:23:06.000Z",
      uuid: "fc_1",
      metadata: {
        toolUses: ["exec_command"],
        toolUseBlocks: [{ id: "call_A", name: "exec_command", input: { cmd: "ls -la" } }],
      },
    });
  });

  it("keeps non-JSON function arguments as a raw string", () => {
    const raw = line({
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: "not json", call_id: "c" },
    });
    expect(parseCodexJsonlLine(raw)?.metadata?.toolUseBlocks?.[0].input).toEqual({
      arguments: "not json",
    });
  });

  it("parses a custom tool call with its raw input", () => {
    expect(parseCodexJsonlLine(customToolCallLine)?.metadata?.toolUseBlocks).toEqual([
      {
        id: "call_B",
        name: "exec",
        input: { input: "const r = await tools.exec_command({cmd: 'pwd'})" },
      },
    ]);
  });

  it("parses a web search as a web_search tool_use", () => {
    expect(parseCodexJsonlLine(webSearchLine)?.metadata?.toolUseBlocks).toEqual([
      {
        id: "ws_1",
        name: "web_search",
        input: { type: "search", query: "codex config", queries: ["codex config"] },
      },
    ]);
  });

  it("parses a string tool output as a tool result tied to its call", () => {
    expect(parseCodexJsonlLine(functionCallOutputLine)).toEqual({
      role: "user",
      text: "",
      timestamp: "2026-06-18T17:23:06.500Z",
      uuid: "fco_1",
      isToolResult: true,
      metadata: {
        toolResults: [
          {
            toolUseId: "call_A",
            type: "generic",
            content: { output: "Process exited with code 0\ntotal 0" },
          },
        ],
      },
    });
  });

  it("joins an array tool output's text parts", () => {
    expect(parseCodexJsonlLine(customToolCallOutputLine)?.metadata?.toolResults?.[0]).toEqual({
      toolUseId: "call_B",
      type: "generic",
      content: { output: "Script completed\n/home/dev/widget" },
    });
  });

  it("parses a reasoning summary as thinking", () => {
    const msg = parseCodexJsonlLine(
      reasoningLine([
        { type: "summary_text", text: "**Checking the pane**" },
        { type: "summary_text", text: "**Reading the log**" },
      ]),
    );
    expect(msg).toMatchObject({
      role: "assistant",
      text: "",
      uuid: "rs_1",
      isThinking: true,
      thinkingContent: "**Checking the pane**\n\n**Reading the log**",
    });
  });

  it("drops reasoning with no readable summary", () => {
    expect(parseCodexJsonlLine(reasoningLine([]))).toBeNull();
    expect(parseCodexJsonlLine(reasoningLine([{ type: "summary_text", text: "" }]))).toBeNull();
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
    // user, assistant, function call, second turn.
    expect(perLine).toHaveLength(4);
  });

  it("does not let a trailing tool result blank lastPrompt or pad fullText", async () => {
    const filePath = join(dir, "rollout-2026-06-18T17-23-00-tail.jsonl");
    writeFileSync(
      filePath,
      `${[sessionMetaLine, userLine, functionCallLine, functionCallOutputLine].join("\n")}\n`,
    );
    const conversation = await parseCodexConversation(filePath, "codex");
    expect(conversation?.messages).toHaveLength(3);
    expect(conversation?.lastPrompt).toBe("hello");
    expect(conversation?.fullText).toBe("hello");
  });
});
