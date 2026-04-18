export { readGitBranch } from "./git";
export { SearchIndexer } from "./indexer";
export {
  detectDefaultProfile,
  getProjectsDir,
  loadProfiles,
  resolveConfigDir,
  saveProfiles,
} from "./profiles";
export { ConversationScanner } from "./scanner";
export { cleanSystemTags } from "./tags";
export { DEFAULT_TIERS, resolveTier } from "./tiers";
export * from "./types";

// ─── Standalone Convenience Functions ───────────────────────────────

import { ConversationScanner } from "./scanner";
import type {
  Conversation,
  GetConversationOptions,
  ScanOptions,
  ScanResult,
  SearchOptions,
  SearchResult,
} from "./types";

export async function scan(options?: ScanOptions): Promise<ScanResult> {
  const scanner = new ConversationScanner();
  return scanner.scan(options);
}

export async function search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
  const scanner = new ConversationScanner();
  return scanner.search(query, options);
}

export async function getConversation(
  id: string,
  options?: GetConversationOptions,
): Promise<Conversation | null> {
  const scanner = new ConversationScanner();
  return scanner.getConversation(id, options);
}
