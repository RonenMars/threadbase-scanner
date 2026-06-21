import { createReadStream } from "fs";
import { createInterface } from "readline";
import { getLogger } from "../logger";
import type { ContentTier, ConversationMeta } from "../types";
import type { ScannerProvider } from "./provider";

// Stream a file through a provider's reducer triplet. This is the same fold a
// future offset-resumed incremental parse would run (createEmptyAccumulator →
// reduceEntry per line → finalize), just starting from offset 0. Bad JSON lines
// and unknown entry shapes are skipped, never fatal.
export async function parseMetaWithProvider(
  provider: ScannerProvider,
  filePath: string,
  account: string,
  tier: ContentTier,
): Promise<ConversationMeta | null> {
  const log = getLogger();
  const acc = provider.createEmptyAccumulator();
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        provider.reduceEntry(acc, entry, tier);
      } catch (err) {
        // A provider reducer should never throw, but one bad line must not kill
        // the whole file.
        log.warn({ filePath, provider: provider.name, err }, "provider reduce threw; line skipped");
      }
    }
  } catch (err) {
    log.warn({ filePath, provider: provider.name, err }, "provider parse: read failed");
    return null;
  }

  return provider.finalize(acc, filePath, account, tier);
}
