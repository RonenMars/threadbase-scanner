import type { ContentTier, ConversationMeta } from "../types";

// A scanner provider knows how to discover and parse one local conversation-log
// format into the shared ConversationMeta model. The reducer triplet
// (createEmptyAccumulator / reduceEntry / finalize) is the same fold used by a
// full streamed parse and — by design — a future offset-resumed incremental
// parse, since the accumulator is plain serializable state. See
// metadata-reducer.ts for the Threadbase implementation this mirrors.
export interface ScannerProvider<Acc = unknown> {
  name: ScannerProviderName;

  // Discover candidate files for this provider under the given roots. Roots are
  // already absolute. Returns one entry per file worth parsing.
  discover(roots: string[]): Promise<DiscoveredConversationFile[]>;

  // Cheap structural sniff: does this file look like this provider's format?
  // `sample` is the first few lines (newline-joined). Used so a single roots
  // list can be shared across providers without misclassifying files.
  canParse(filePath: string, sample: string): boolean;

  createEmptyAccumulator(): Acc;

  // Fold one already-JSON.parsed line into the accumulator, in place. Must never
  // throw on an unknown entry shape — ignore what it doesn't understand.
  reduceEntry(acc: Acc, entry: Record<string, unknown>, tier: ContentTier): void;

  // Build the ConversationMeta from the accumulator, or null if no messages.
  finalize(acc: Acc, filePath: string, account: string, tier: ContentTier): ConversationMeta | null;
}

export type ScannerProviderName = "claude-code" | "codex-cli" | "cursor";

export const CLAUDE_CODE_PROVIDER = "claude-code" as const;
export const CODEX_CLI_PROVIDER = "codex-cli" as const;
export const CURSOR_PROVIDER = "cursor" as const;
/** Live PTY on main shipped this wire name; accept it and emit `cursor`. */
export const LEGACY_CURSOR_PROVIDER = "cursor-cli" as const;

export function canonicalizeProviderName(value: string): ScannerProviderName | undefined {
  if (value === LEGACY_CURSOR_PROVIDER) return CURSOR_PROVIDER;
  if (value === CLAUDE_CODE_PROVIDER || value === CODEX_CLI_PROVIDER || value === CURSOR_PROVIDER) {
    return value;
  }
  return undefined;
}

export function canonicalizeProviderList(
  providers: readonly string[] | undefined,
): ScannerProviderName[] {
  const src = providers ?? [CLAUDE_CODE_PROVIDER];
  const out: ScannerProviderName[] = [];
  for (const p of src) {
    const n = canonicalizeProviderName(p);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export function providerMatches(stored: string | undefined, wanted: string): boolean {
  const a = canonicalizeProviderName(stored ?? CLAUDE_CODE_PROVIDER) ?? stored;
  const b = canonicalizeProviderName(wanted) ?? wanted;
  return a === b;
}

export interface DiscoveredConversationFile {
  filePath: string;
  account: string;
}
