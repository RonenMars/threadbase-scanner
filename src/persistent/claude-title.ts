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
}

export function resolveClaudeTitle(state: ClaudeTitleState): string {
  return state.customTitle || state.aiTitle || state.lastPrompt ||
    cleanSystemTags(state.firstUserTitle) || state.slug || "";
}
