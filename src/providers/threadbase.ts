import { discoverJsonlFiles } from "../discovery";
import {
  finalizeMeta,
  initialReducerState,
  type ReducerState,
  reduceLine,
} from "../persistent/metadata-reducer";
import type { ContentTier, ConversationMeta } from "../types";
import type { DiscoveredConversationFile, ScannerProvider } from "./provider";

// The existing Claude/Threadbase format, expressed as a provider. All behavior
// is the already-shared reducer (metadata-reducer.ts) — no logic is duplicated
// here. Discovery is delegated to discoverJsonlFiles; the scanner passes the
// profiles' projects dirs as roots paired with their account ids.
export class ThreadbaseProvider implements ScannerProvider<ReducerState> {
  readonly name = "threadbase" as const;

  // Roots are passed as "<projectsDir>\0<account>" so the scanner can carry the
  // per-root account through the shared interface. The scanner builds these.
  async discover(roots: string[]): Promise<DiscoveredConversationFile[]> {
    const dirs = roots.map((r) => {
      const [projectsDir, account = "default"] = r.split("\0");
      return { projectsDir, account };
    });
    return discoverJsonlFiles(dirs);
  }

  // Threadbase JSONL has top-level type "user"/"assistant" with a cwd/sessionId.
  canParse(_filePath: string, sample: string): boolean {
    for (const line of sample.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e.type === "user" || e.type === "assistant") return true;
        // Codex's distinctive top-level types — definitively not us.
        if (e.type === "session_meta" || e.type === "response_item") return false;
      } catch {}
    }
    return false;
  }

  createEmptyAccumulator(): ReducerState {
    return initialReducerState();
  }

  reduceEntry(acc: ReducerState, entry: Record<string, unknown>, tier: ContentTier): void {
    reduceLine(acc, entry, tier);
  }

  finalize(
    acc: ReducerState,
    filePath: string,
    account: string,
    tier: ContentTier,
  ): ConversationMeta | null {
    // finalizeMeta already tags provider: "threadbase".
    return finalizeMeta(acc, filePath, account, tier);
  }
}
