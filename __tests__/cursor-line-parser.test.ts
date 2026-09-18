// parseCursorJsonlLine's tool_use handling. The assistant line below keeps the
// exact key shape a real Cursor agent-transcripts line has — {role, message:
// {content: [text | tool_use{name, input}]}}, no id on tool_use, no timestamp.
import { describe, expect, it } from "vitest";
import { parseCursorJsonlLine } from "../src/providers/cursor";

const line = (o: unknown): string => JSON.stringify(o);

const shell = {
  type: "tool_use",
  name: "Shell",
  input: { command: "gh pr view 1", description: "PR" },
};
const glob = { type: "tool_use", name: "Glob", input: { glob_pattern: "**/*.yml" } };

describe("parseCursorJsonlLine tool_use", () => {
  it("attaches tool_use blocks to a message that also has text", () => {
    const msg = parseCursorJsonlLine(
      line({
        role: "assistant",
        message: { content: [{ type: "text", text: "Looking it up." }, shell, glob] },
      }),
    );
    expect(msg?.text).toBe("Looking it up.");
    expect(msg?.metadata?.toolUses).toEqual(["Shell", "Glob"]);
    expect(msg?.metadata?.toolUseBlocks?.map((b) => [b.name, b.input])).toEqual([
      ["Shell", shell.input],
      ["Glob", glob.input],
    ]);
  });

  it("renders a tool-only line instead of dropping it", () => {
    const msg = parseCursorJsonlLine(line({ role: "assistant", message: { content: [shell] } }));
    expect(msg).toMatchObject({ role: "assistant", text: "" });
    expect(msg?.metadata?.toolUseBlocks).toHaveLength(1);
  });

  it("derives a stable, distinct id for id-less tool_use blocks", () => {
    const a = parseCursorJsonlLine(
      line({ role: "assistant", message: { content: [shell, glob] } }),
    );
    const b = parseCursorJsonlLine(
      line({ role: "assistant", message: { content: [shell, glob] } }),
    );
    const ids = a?.metadata?.toolUseBlocks?.map((x) => x.id) ?? [];
    expect(ids).toEqual(b?.metadata?.toolUseBlocks?.map((x) => x.id));
    expect(ids[0]).toMatch(/^cursor-tool-[0-9a-f]{16}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("keeps an id the block already carries", () => {
    const msg = parseCursorJsonlLine(
      line({ role: "assistant", message: { content: [{ ...shell, id: "toolu_1" }] } }),
    );
    expect(msg?.metadata?.toolUseBlocks?.[0].id).toBe("toolu_1");
  });

  it("still drops a line with neither text nor tool calls", () => {
    expect(parseCursorJsonlLine(line({ role: "assistant", message: { content: [] } }))).toBeNull();
    expect(parseCursorJsonlLine(line({ type: "turn_ended", status: "error" }))).toBeNull();
  });
});
