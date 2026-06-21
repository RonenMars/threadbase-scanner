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

export const CLAUDE_CODE_PROVIDER = "claude-code" as const;
export const CODEX_CLI_PROVIDER = "codex-cli" as const;

export type ScannerProviderName = typeof CLAUDE_CODE_PROVIDER | typeof CODEX_CLI_PROVIDER;

export interface DiscoveredConversationFile {
  filePath: string;
  account: string;
}
