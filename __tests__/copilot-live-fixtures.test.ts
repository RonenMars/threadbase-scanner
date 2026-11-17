import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseCopilotConversation, parseCopilotJsonlLine } from "../src/providers/copilot";

// Live captures are optional: the directory may hold nothing but its README, and
// then the per-file suite below is skipped instead of failing CI.
const LIVE_DIR = join(__dirname, "..", "__fixtures__", "copilot", "live");
const liveFiles = existsSync(LIVE_DIR)
  ? readdirSync(LIVE_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
  : [];

// An independent copy of the documented mapping, so a drift in the parser's table
// fails here instead of being echoed back by it.
const DOCUMENTED: Record<string, { label: string; isError: boolean }> = {
  approved: { label: "Approved", isError: false },
  "approved-for-location": { label: "Approved (and remembered)", isError: false },
  "denied-interactively-by-user": { label: "Denied", isError: true },
  cancelled: { label: "Cancelled", isError: true },
};

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Returns one problem per violation, each naming the line; an empty list means the file is fine. */
function checkLiveEvents(lines: string[]): string[] {
  const problems: string[] = [];
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    if (!line.trim()) return;
    let entry: Json;
    try {
      entry = JSON.parse(line) as Json;
    } catch (err) {
      problems.push(`${at}: not valid JSON (${(err as Error).message})`);
      return;
    }
    let message: ReturnType<typeof parseCopilotJsonlLine>;
    try {
      message = parseCopilotJsonlLine(line);
    } catch (err) {
      problems.push(`${at}: parser threw (${(err as Error).message})`);
      return;
    }
    const type = str(entry.type);
    if (type !== "permission.completed" && type !== "tool.execution_complete") return;
    const data = rec(entry.data);
    const toolCallId = str(data.toolCallId);
    const result = rec(data.result);

    if (!toolCallId) {
      if (message !== null) problems.push(`${at}: ${type} without toolCallId produced a message`);
      return;
    }
    if (type === "permission.completed") {
      const kind = str(result.kind);
      const decision = Object.hasOwn(DOCUMENTED, kind) ? DOCUMENTED[kind] : undefined;
      if (!decision) {
        problems.push(
          `${at}: permission.completed has unknown kind "${kind}"; the scanner drops it, so add it to PERMISSION_DECISIONS`,
        );
        return;
      }
      const feedback = kind === "denied-interactively-by-user" ? str(result.feedback).trim() : "";
      const expected = feedback ? `${decision.label}: ${feedback}` : decision.label;
      const got = toolResult(message, at, toolCallId, problems);
      if (!got) return;
      if (got.content.output !== expected) {
        problems.push(
          `${at}: permission "${kind}" output is ${JSON.stringify(got.content.output)}, expected ${JSON.stringify(expected)}`,
        );
      }
      if (got.content.permission !== kind) {
        problems.push(`${at}: permission "${kind}" not carried in content.permission`);
      }
      if ((got.isError === true) !== decision.isError) {
        problems.push(`${at}: permission "${kind}" isError should be ${decision.isError}`);
      }
      return;
    }
    const got = toolResult(message, at, toolCallId, problems);
    if (!got) return;
    const expected = str(result.content) || str(result.detailedContent);
    if (got.content.output !== expected) {
      problems.push(`${at}: tool.execution_complete output does not match content/detailedContent`);
    }
    if ((got.isError === true) !== (data.success === false)) {
      problems.push(`${at}: tool.execution_complete isError should be ${data.success === false}`);
    }
  });
  return problems;
}

function toolResult(
  message: ReturnType<typeof parseCopilotJsonlLine>,
  at: string,
  toolCallId: string,
  problems: string[],
): { content: Json; isError?: boolean } | null {
  if (!message) {
    problems.push(`${at}: toolCallId ${toolCallId} produced no message`);
    return null;
  }
  if (message.isToolResult !== true) {
    problems.push(`${at}: message for ${toolCallId} is not isToolResult`);
    return null;
  }
  const block = message.metadata?.toolResults?.[0];
  if (!block || block.toolUseId !== toolCallId) {
    problems.push(`${at}: toolUseId ${block?.toolUseId} does not match toolCallId ${toolCallId}`);
    return null;
  }
  return { content: rec(block.content), isError: block.isError };
}

const ev = (type: string, data: Json) =>
  JSON.stringify({ type, data, id: "e", timestamp: "t", parentId: null });
const perm = (kind: string, extra: Json = {}, toolCallId: string | null = "c1") =>
  ev("permission.completed", {
    ...(toolCallId ? { toolCallId } : {}),
    requestId: "r1",
    result: { kind, ...extra },
  });

describe("checkLiveEvents (synthetic input)", () => {
  it.each(Object.keys(DOCUMENTED))("accepts a %s decision", (kind) => {
    expect(checkLiveEvents([perm(kind)])).toEqual([]);
  });

  it("accepts a denial with feedback", () => {
    expect(
      checkLiveEvents([perm("denied-interactively-by-user", { feedback: " use rg " })]),
    ).toEqual([]);
  });

  it("names an unknown kind", () => {
    const problems = checkLiveEvents([perm("approved-forever")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unknown kind "approved-forever"');
    expect(problems[0]).toContain("line 1");
  });

  it("accepts a permission.completed without toolCallId (the scanner drops it)", () => {
    expect(checkLiveEvents([perm("approved", {}, null)])).toEqual([]);
  });

  it("accepts tool.execution_complete with content, detailedContent fallback and failure", () => {
    expect(
      checkLiveEvents([
        ev("tool.execution_complete", {
          toolCallId: "a",
          success: true,
          result: { content: "ok" },
        }),
        ev("tool.execution_complete", {
          toolCallId: "b",
          success: true,
          result: { detailedContent: "long" },
        }),
        ev("tool.execution_complete", {
          toolCallId: "c",
          success: false,
          result: { content: "x" },
        }),
      ]),
    ).toEqual([]);
  });

  it("ignores events that are not results", () => {
    expect(checkLiveEvents([ev("session.start", { sessionId: "s" })])).toEqual([]);
  });

  it("reports malformed JSON with its line number", () => {
    const problems = checkLiveEvents([perm("approved"), "{oops"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("line 2");
    expect(problems[0]).toContain("not valid JSON");
  });
});

describe.skipIf(liveFiles.length === 0)("live Copilot captures", () => {
  describe.each(liveFiles)("%s", (name) => {
    const path = join(LIVE_DIR, name);
    const lines = readFileSync(path, "utf8").split("\n");

    it("parses every line and maps every result and permission event", () => {
      expect(checkLiveEvents(lines)).toEqual([]);
    });

    it("loads as a conversation holding a tool result for each toolCallId", async () => {
      const convo = await parseCopilotConversation(path, "test");
      expect(convo).not.toBeNull();
      const resultIds = new Set(
        (convo?.messages ?? []).flatMap((m) =>
          m.isToolResult ? (m.metadata?.toolResults ?? []).map((r) => r.toolUseId) : [],
        ),
      );
      const wanted = lines
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Json)
        .filter((e) => e.type === "tool.execution_complete")
        .map((e) => str(rec(e.data).toolCallId))
        .filter(Boolean);
      for (const id of wanted) expect(resultIds.has(id)).toBe(true);
    });
  });
});
