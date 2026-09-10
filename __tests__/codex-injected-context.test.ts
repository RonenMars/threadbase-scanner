import { join } from "path";
import { CodexCliProvider } from "../src/providers/codex-cli";
import { parseMetaWithProvider } from "../src/providers/parse";
import { resolveTier } from "../src/tiers";
import type { ConversationMeta } from "../src/types";

const CODEX_FIXTURES = join(__dirname, "..", "__fixtures__", "codex-cli");
const TIER = resolveTier("standard");

const codex = (file: string): Promise<ConversationMeta | null> =>
  parseMetaWithProvider(new CodexCliProvider(), join(CODEX_FIXTURES, file), "codex", TIER);

async function meta(file: string): Promise<ConversationMeta> {
  const m = await codex(file);
  if (!m) throw new Error(`expected meta for ${file}`);
  return m;
}

// Codex prepends its AGENTS.md / sandbox preamble as the first `user` turn, so
// the reducer's role guard cannot catch it — it is the right category wearing the
// wrong label. Left in, it becomes every conversation's preview, firstMessage and
// an extra messageCount, which is what made 62% of cached Codex conversations
// show the same "# AGENTS.md instructions for …" preview.
describe("Codex injected context is not a user-visible turn", () => {
  it.each([
    ["injected-agents-md.jsonl", "fix the flaky login test"],
    ["injected-instructions.jsonl", "rename the helper"],
    ["injected-permissions.jsonl", "summarise the diff"],
  ])("skips the leading injected turn in %s", async (file, realTurn) => {
    const m = await meta(file);
    // The real opening turn supplies all three, not the blob.
    expect(m.preview.startsWith(realTurn)).toBe(true);
    expect(m.firstMessage?.text).toBe(realTurn);
    expect(m.sessionName).toBe(realTurn);
    // One user turn and one assistant turn — the blob is not counted.
    expect(m.messageCount).toBe(2);
    // Nothing anywhere still carries the injected text.
    expect(m.preview).not.toContain("AGENTS.md");
    expect(m.preview).not.toContain("<INSTRUCTIONS>");
    expect(m.contentSnippet).not.toContain("Filesystem sandboxing defines");
  });

  // Positive control for the three above: without a fixture that has NO injected
  // turn, a filter that dropped every user message would pass them all.
  it("leaves a rollout without injected context completely unchanged", async () => {
    const m = await meta("no-injected.jsonl");
    expect(m.preview.startsWith("just a normal opening question")).toBe(true);
    expect(m.firstMessage?.text).toBe("just a normal opening question");
    expect(m.sessionName).toBe("just a normal opening question");
    expect(m.messageCount).toBe(2);
  });

  // The skip is bounded to LEADING turns. A human pasting instruction text
  // mid-conversation must still be counted and previewable: messageCount is a
  // number people compare against what they can see.
  it("counts an <INSTRUCTIONS> turn that arrives after a real one", async () => {
    const m = await meta("injected-late.jsonl");
    expect(m.sessionName).toBe("real opening turn");
    expect(m.messageCount).toBe(3);
    expect(m.contentSnippet).toContain("<INSTRUCTIONS>");
  });

  // A rollout that is nothing but the injected turn has no user-visible content,
  // so it must not surface as a one-message conversation.
  it("yields no conversation when the injected turn is all there is", async () => {
    expect(await codex("injected-only.jsonl")).toBeNull();
  });
});

// Codex rollouts carry no slug, so before this the title was always empty and
// clients fell back to the project path — which is why every Codex card looked
// alike. The fallback only became useful once the blob was skipped: applied
// before, it would have made every title the AGENTS.md blob.
describe("Codex title falls back to the opening turn", () => {
  it("derives it from the first real user message, mirroring the Claude reducer", async () => {
    const m = await meta("injected-agents-md.jsonl");
    expect(m.sessionName).toBe("fix the flaky login test");
    expect(m.sessionName).not.toBe("");
    expect(m.sessionName).not.toContain("AGENTS.md");
  });
});
