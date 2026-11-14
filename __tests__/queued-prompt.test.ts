import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConversation, parseMeta } from "../src/parser";
import { DEFAULT_TIERS } from "../src/tiers";

// Shapes copied from a real Claude Code transcript: a prompt typed while the
// agent was mid-turn is written only as a queued_command attachment. Task
// notifications and peer messages arrive through the same attachment type.
const queued = (uuid: string, prompt: unknown, commandMode: string, origin: unknown) => ({
  type: "attachment",
  uuid,
  timestamp: "2026-01-01T09:02:00.000Z",
  isSidechain: false,
  attachment: { type: "queued_command", prompt, commandMode, origin, humanTurn: true },
});

const ROWS = [
  {
    type: "user",
    uuid: "u1",
    timestamp: "2026-01-01T09:00:00.000Z",
    message: { role: "user", content: "Fix the build" },
  },
  {
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-01-01T09:01:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Looking." }] },
  },
  queued("q1", "commit and open PR", "prompt", { kind: "human" }),
  queued("q2", [{ type: "text", text: "and push it" }], "prompt", { kind: "human" }),
  queued("t1", "<task-notification>done</task-notification>", "task-notification", {
    kind: "task-notification",
  }),
  queued("p1", "<cross-session-message>hi</cross-session-message>", "prompt", { kind: "peer" }),
  {
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-01-01T09:03:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Committed." }] },
  },
]
  .map((r) => JSON.stringify({ ...r, sessionId: "sess-queued", cwd: "/project" }))
  .join("\n");

describe("prompts sent mid-turn", () => {
  let dir: string;
  let file: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "queued-prompt-"));
    file = join(dir, "queued.jsonl");
    writeFileSync(file, ROWS);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps a human queued prompt as a user message, in order", async () => {
    const conv = await parseConversation(file, "default");
    expect(conv?.messages.map((m) => [m.uuid, m.role, m.text])).toEqual([
      ["u1", "user", "Fix the build"],
      ["a1", "assistant", "Looking."],
      ["q1", "user", "commit and open PR"],
      ["q2", "user", "and push it"],
      ["a2", "assistant", "Committed."],
    ]);
    expect(conv?.messages.find((m) => m.uuid === "q1")?.attachment).toBeUndefined();
  });

  it("counts it, so the metadata total matches the message list", async () => {
    const meta = await parseMeta(file, "default", DEFAULT_TIERS.standard);
    expect(meta?.messageCount).toBe(5);
    expect(meta?.lastMessage?.text).toBe("Committed.");
  });
});
