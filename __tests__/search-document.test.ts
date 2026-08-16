import {
  appendSearchDelta,
  capToolPayload,
  combineSearchContent,
  emptySearchDocument,
  extractSearchDelta,
  SEARCH_BUDGET,
  searchDocumentsEqual,
} from "../src/search-document";

const claudeUser = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: { content },
  ...extra,
});

const claudeAssistant = (content: unknown) => ({
  type: "assistant",
  message: { content },
});

describe("extractSearchDelta - Claude", () => {
  it("puts plain user text in the text bucket", () => {
    const d = extractSearchDelta(claudeUser("deploy the widget"));
    expect(d.text).toBe("deploy the widget");
    expect(d.thinking).toBe("");
    expect(d.tools).toBe("");
  });

  it("puts type:text blocks in the text bucket", () => {
    const d = extractSearchDelta(claudeAssistant([{ type: "text", text: "socket reconnect" }]));
    expect(d.text).toBe("socket reconnect");
  });

  it("strips system-tag wrappers from text so they are not searchable as body", () => {
    const d = extractSearchDelta(
      claudeUser("<system-reminder>NEEDLEINWRAPPER</system-reminder>real question here"),
    );
    expect(d.text).not.toContain("NEEDLEINWRAPPER");
    expect(d.text).toContain("real question here");
  });

  it("keeps the same token when it appears in genuine body text", () => {
    const d = extractSearchDelta(claudeUser("NEEDLEINWRAPPER matters here"));
    expect(d.text).toContain("NEEDLEINWRAPPER");
  });

  it("indexes thinking content but never the signature", () => {
    const d = extractSearchDelta(
      claudeAssistant([
        { type: "thinking", thinking: "THINKNEEDLE reasoning", signature: "SIGNEEDLEbase64blob" },
      ]),
    );
    expect(d.thinking).toContain("THINKNEEDLE");
    expect(d.thinking).not.toContain("SIGNEEDLE");
    expect(d.text).not.toContain("SIGNEEDLE");
  });

  it("routes tool_use input and tool_result to tools, never to text", () => {
    const d = extractSearchDelta(
      claudeUser([
        { type: "tool_use", name: "Read", input: { file: "TOOLINPUTNEEDLE" } },
        { type: "tool_result", content: "TOOLRESULTNEEDLE" },
      ]),
    );
    expect(d.tools).toContain("TOOLINPUTNEEDLE");
    expect(d.tools).toContain("TOOLRESULTNEEDLE");
    expect(d.text).toBe("");
  });

  it("indexes the top-level toolUseResult, not just message.content", () => {
    const d = extractSearchDelta(
      claudeUser([{ type: "tool_result", content: "short" }], {
        toolUseResult: { stdout: "STRUCTUREDNEEDLE from the command" },
      }),
    );
    expect(d.tools).toContain("STRUCTUREDNEEDLE");
  });

  it("ignores isMeta entries", () => {
    const d = extractSearchDelta(claudeUser("ignored", { isMeta: true }));
    expect(d).toEqual(emptySearchDocument());
  });
});

describe("extractSearchDelta - Codex", () => {
  const codex = (payload: Record<string, unknown>) => ({ type: "response_item", payload });

  it("extracts message text", () => {
    const d = extractSearchDelta(
      codex({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "CODEXNEEDLE" }],
      }),
    );
    expect(d.text).toContain("CODEXNEEDLE");
  });

  it("extracts reasoning into thinking", () => {
    const d = extractSearchDelta(
      codex({ type: "reasoning", summary: [{ type: "summary_text", text: "REASONNEEDLE" }] }),
    );
    expect(d.thinking).toContain("REASONNEEDLE");
  });

  it("extracts function call arguments and output into tools", () => {
    expect(
      extractSearchDelta(codex({ type: "function_call", arguments: '{"q":"ARGNEEDLE"}' })).tools,
    ).toContain("ARGNEEDLE");
    expect(
      extractSearchDelta(codex({ type: "function_call_output", output: "OUTNEEDLE" })).tools,
    ).toContain("OUTNEEDLE");
  });

  it("skips developer/system roles", () => {
    const d = extractSearchDelta(
      codex({
        type: "message",
        role: "developer",
        content: [{ type: "text", text: "boilerplate" }],
      }),
    );
    expect(d.text).toBe("");
  });
});

describe("capToolPayload", () => {
  it("caps one oversized payload at toolPayloadMax", () => {
    const capped = capToolPayload("x".repeat(SEARCH_BUDGET.toolPayloadMax * 3));
    expect(capped.length).toBe(SEARCH_BUDGET.toolPayloadMax);
  });

  it("stringifies structured payloads", () => {
    expect(capToolPayload({ a: "NEEDLE" })).toContain("NEEDLE");
  });

  it("returns empty for null/undefined", () => {
    expect(capToolPayload(null)).toBe("");
    expect(capToolPayload(undefined)).toBe("");
  });
});

describe("appendSearchDelta - tail bias", () => {
  const delta = (text: string) => ({ text, thinking: "", tools: "" });

  it("keeps the newest text and drops the oldest when the window is full", () => {
    let doc = emptySearchDocument();
    doc = appendSearchDelta(doc, delta(`OLDESTNEEDLE${"a".repeat(SEARCH_BUDGET.textMax)}`));
    doc = appendSearchDelta(doc, delta("NEWESTNEEDLE"));

    expect(doc.text).toContain("NEWESTNEEDLE");
    expect(doc.text).not.toContain("OLDESTNEEDLE");
    expect(doc.text.length).toBe(SEARCH_BUDGET.textMax);
  });

  it("still admits new text after the bucket was already full (no head-biased freeze)", () => {
    let doc = emptySearchDocument();
    doc = appendSearchDelta(doc, delta("b".repeat(SEARCH_BUDGET.textMax * 2)));
    doc = appendSearchDelta(doc, delta("LATERNEEDLE"));
    expect(doc.text).toContain("LATERNEEDLE");
  });

  it("enforces each bucket independently - huge tools never displace text", () => {
    let doc = emptySearchDocument();
    doc = appendSearchDelta(doc, { text: "TEXTNEEDLE", thinking: "", tools: "" });
    doc = appendSearchDelta(doc, {
      text: "",
      thinking: "",
      tools: "t".repeat(SEARCH_BUDGET.toolsMax * 3),
    });

    expect(doc.text).toBe("TEXTNEEDLE");
    expect(doc.tools.length).toBe(SEARCH_BUDGET.toolsMax);
    expect(doc.thinking).toBe("");
  });

  it("later user text enters the text bucket after tools were stored", () => {
    let doc = emptySearchDocument();
    doc = appendSearchDelta(doc, { text: "", thinking: "", tools: "tool output" });
    doc = appendSearchDelta(doc, { text: "LATERUSERNEEDLE", thinking: "", tools: "" });
    expect(doc.text).toBe("LATERUSERNEEDLE");
  });

  it("separates fragments so adjacent messages do not fuse into one token", () => {
    let doc = emptySearchDocument();
    doc = appendSearchDelta(doc, { text: "finished.", thinking: "", tools: "" });
    doc = appendSearchDelta(doc, { text: "Next", thinking: "", tools: "" });
    expect(doc.text).toBe("finished.\n\nNext");
  });

  it("is a no-op for an empty delta", () => {
    const doc = { text: "a", thinking: "b", tools: "c" };
    expect(searchDocumentsEqual(appendSearchDelta(doc, emptySearchDocument()), doc)).toBe(true);
  });
});

describe("combineSearchContent", () => {
  it("orders text, thinking, tools and skips empties", () => {
    expect(combineSearchContent({ text: "T", thinking: "", tools: "L" })).toBe("T\n\nL");
  });
});
