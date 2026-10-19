import { cleanSystemTags } from "../tags";

export interface ClaudeTitleState {
  customTitle: string;
  aiTitle: string;
  lastPrompt: string;
  firstUserTitle: string;
  slug: string;
}

// Persisted in incremental reducer state. Repeated title records use their
// last nonempty value; precedence is applied only when resolving.
export function foldClaudeTitle(state: ClaudeTitleState, entry: Record<string, unknown>): void {
  if (typeof entry.slug === "string" && entry.slug.trim()) state.slug = entry.slug.trim();
  if (entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim())
    state.customTitle = entry.customTitle.trim();
  if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim())
    state.aiTitle = entry.aiTitle.trim();
  if (entry.type === "last-prompt" && typeof entry.lastPrompt === "string" && entry.lastPrompt.trim())
    state.lastPrompt = entry.lastPrompt.trim();

  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary ||
      entry.toolUseResult != null || state.firstUserTitle) return;
  const message = entry.message as { content?: unknown } | undefined;
  state.firstUserTitle = firstUserTitle("", message?.content);
}

// The picker renders the slash command from its command-name tag when there
// is no ordinary user text (for example /model).
export function firstUserTitle(text: string, raw: unknown): string {
  const normalized = cleanSystemTags(text);
  if (normalized) return normalized;
  const blocks = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((part) => part?.type === "text").map((part) => part.text).filter((value): value is string => typeof value === "string") : [];
  for (const block of blocks) {
    const cleaned = cleanSystemTags(block);
    if (cleaned) return cleaned;
  }
  for (const block of blocks) {
    const command = block.match(/<command-name>\s*([^<]+)\s*<\/command-name>/)?.[1]?.trim();
    if (command) return command.startsWith("/") ? command : `/${command}`;
  }
  return "";
}

export function resolveClaudeTitle(state: ClaudeTitleState): string {
  return state.customTitle || state.aiTitle || state.lastPrompt ||
    cleanSystemTags(state.firstUserTitle) || state.slug || "";
}
