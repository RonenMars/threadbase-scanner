import type { ScannerProviderName } from "./providers/provider";
import { cleanSystemTags } from "./tags";

export type NameSlot = "userTitle" | "toolTitle" | "lastPrompt" | "firstUserMessage" | "slug";

// Highest first: the first non-empty slot is the session's name.
export const NAME_PRECEDENCE: readonly NameSlot[] = [
  "userTitle",
  "toolTitle",
  "lastPrompt",
  "firstUserMessage",
  "slug",
];

export interface NameSlots {
  userTitle?: string;
  toolTitle?: string;
  lastPrompt?: string;
  firstUserMessage?: string; // set once, never replaced
  slug?: string;
}

export interface ResolvedSessionName {
  name: string | null; // full, untruncated
  source: NameSlot | null;
}

// Text the host injects as a "user" turn. Matched against the trimmed text.
const CLAUDE_SYSTEM_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<system-reminder>",
  "<task-notification>",
  "<teammate-message",
  "Another Claude session sent a message:",
  "[Request interrupted by user",
];

const CODEX_SYSTEM_PREFIXES = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<INSTRUCTIONS>",
  "<external_codex_apps_open",
  "<user_shell_command>",
  "<turn_aborted>",
];

/**
 * Boilerplate Codex injects as a `user`-role turn. Codex-generic only — prompts a
 * host passes as argv (Codex has no --system-prompt flag) also land as role:user,
 * but recognising those is the host's business, not the scanner's.
 */
export function isCodexInjectedContext(text: string): boolean {
  // AGENTS.md / instruction dumps prepended as the opening turn.
  if (text.startsWith("# AGENTS.md") || text.includes("<INSTRUCTIONS>")) return true;
  // Permissions / sandbox preamble, sometimes a giant user-role blob.
  return (
    text.startsWith("<permissions instructions>") || text.includes("Filesystem sandboxing defines")
  );
}

const CODEX_IMAGE_TAG_RE = /<\/?image\b[^>]*>/g;

// The text to store for a candidate, or null when it cannot name a session.
function normalizeCandidate(text: string, provider: ScannerProviderName): string | null {
  let t = text.trim();
  if (provider === "codex-cli") t = t.replace(CODEX_IMAGE_TAG_RE, "").trim();
  const prefixes =
    provider === "claude-code"
      ? CLAUDE_SYSTEM_PREFIXES
      : provider === "codex-cli"
        ? CODEX_SYSTEM_PREFIXES
        : [];
  if (prefixes.some((p) => t.startsWith(p))) return null;
  if (provider === "codex-cli" && isCodexInjectedContext(t)) return null;
  return cleanSystemTags(t) || null;
}

export function isValidNameCandidate(text: string, provider: ScannerProviderName): boolean {
  return normalizeCandidate(text, provider) !== null;
}

// Pure: same slots in, same name out.
export function resolveSessionName(slots: NameSlots): ResolvedSessionName {
  for (const slot of NAME_PRECEDENCE) {
    const value = slots[slot];
    if (value?.trim()) return { name: value, source: slot };
  }
  return { name: null, source: null };
}

// The single write path for every slot: the last valid occurrence wins, an
// invalid candidate never overwrites a valid value, and firstUserMessage is set
// once. Returns a new object, or the input unchanged when nothing applies.
export function applyNameCandidate(
  slots: NameSlots,
  slot: NameSlot,
  raw: string | undefined,
  provider: ScannerProviderName,
): NameSlots {
  if (typeof raw !== "string") return slots;
  if (slot === "firstUserMessage" && slots.firstUserMessage !== undefined) return slots;
  const text = normalizeCandidate(raw, provider);
  return text === null ? slots : { ...slots, [slot]: text };
}
