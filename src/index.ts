export {
  applyAccountFilter,
  applyIncludeFilter,
  applyPagination,
  applyProjectFilter,
  applySinceFilter,
  applySort,
} from "./filters";
export { readGitBranch } from "./git";
export { SearchIndexer } from "./indexer";
export type { Logger, LoggerOptions } from "./logger";
export { createLogger, getLogger, setLogger } from "./logger";
export {
  detectDefaultProfile,
  getProjectsDir,
  loadProfiles,
  resolveConfigDir,
  saveProfiles,
} from "./profiles";
export type {
  ConversationScannerOptions,
  PersistentConfig,
  ScannerChangeEvent,
  WatchOptions,
} from "./scanner";
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

let defaultScanner: ConversationScanner | undefined;

function getDefaultScanner(): ConversationScanner {
  if (!defaultScanner) {
    defaultScanner = new ConversationScanner();
  }
  return defaultScanner;
}

export function resetDefaultScanner(): void {
  defaultScanner = undefined;
}

export async function scan(
  options?: ScanOptions,
  scanner?: ConversationScanner,
): Promise<ScanResult> {
  return (scanner ?? getDefaultScanner()).scan(options);
}

export async function search(
  query: string,
  options?: SearchOptions,
  scanner?: ConversationScanner,
): Promise<SearchResult[]> {
  return (scanner ?? getDefaultScanner()).search(query, options);
}

export async function getConversation(
  id: string,
  options?: GetConversationOptions,
  scanner?: ConversationScanner,
): Promise<Conversation | null> {
  return (scanner ?? getDefaultScanner()).getConversation(id, options);
}
