import { applyNameCandidate, type NameSlots } from "../session-name";

// Prompt text of a user entry, or "" when it can't name a session: injected
// meta/compaction rows, and entries with no `text` block (tool results only).
// Raw on purpose: the prefix checks in isValidNameCandidate run before tags are
// cleaned, so a `<command-name>` row is rejected rather than emptied.
function userPromptText(entry: Record<string, unknown>): string {
  if (entry.isMeta || entry.isCompactSummary === true) return "";
  const content = (entry.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : ""))
    .filter((t): t is string => typeof t === "string" && t !== "")
    .join(" ");
}

// Maps one Claude JSONL entry to its name-slot candidates. Shared by the
// metadata and conversation reducers so neither keeps its own naming logic.
export function applyClaudeNameEntry(slots: NameSlots, entry: Record<string, unknown>): NameSlots {
  const apply = (slot: Parameters<typeof applyNameCandidate>[1], raw: unknown) =>
    applyNameCandidate(slots, slot, typeof raw === "string" ? raw : undefined, "claude-code");

  // slug rides on every entry of a session, so skip the re-normalising when it
  // is the value already held — this runs once per line of a 100k-line file.
  if (entry.slug !== slots.slug) slots = apply("slug", entry.slug);
  switch (entry.type) {
    case "custom-title":
      return apply("userTitle", entry.customTitle);
    case "ai-title":
      return apply("toolTitle", entry.aiTitle);
    case "last-prompt":
      return apply("lastPrompt", entry.lastPrompt);
    case "user":
      return slots.firstUserMessage === undefined
        ? apply("firstUserMessage", userPromptText(entry))
        : slots;
    default:
      return slots;
  }
}
