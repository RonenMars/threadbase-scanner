import { discoverJsonlFiles } from "../discovery";
import { readGitBranch } from "../git";
import { getLogger } from "../logger";
import { getProjectsDir } from "../profiles";
import { resolveTier } from "../tiers";
import type { ConversationMeta, Profile, ScanOptions } from "../types";
import { classify, fingerprint } from "./cursor";
import { type DB, openDatabase } from "./db";
import { type TailReadResult, tailReduce } from "./jsonl-tail-reader";
import { finalizeMeta, initialReducerState, type ReducerState } from "./metadata-reducer";
import { ConversationFilesRepo } from "./repositories/conversation-files.repo";
import { ConversationsRepo } from "./repositories/conversations.repo";
import { FtsRepo } from "./repositories/fts.repo";

const BATCH_SIZE = 12;

// Persistent indexing engine. Owns the SQLite connection and the discover ->
// classify -> tail-read -> upsert pipeline. Query helpers return ConversationMeta
// straight from the DB so the scanner facade can run the existing
// filter/sort/view pipeline over them, guaranteeing parity with the in-memory
// path.
//
// Indexing is incremental: an appended file resumes the persisted reducer fold
// from its byte cursor and reads only the new bytes (cursor.ts + the tail
// reader); a truncated/replaced file reindexes from offset 0.
export class PersistentEngine {
  readonly db: DB;
  readonly files: ConversationFilesRepo;
  readonly conversations: ConversationsRepo;
  readonly fts: FtsRepo;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.files = new ConversationFilesRepo(this.db);
    this.conversations = new ConversationsRepo(this.db);
    this.fts = new FtsRepo(this.db);
  }

  close(): void {
    this.db.close();
  }

  // Discover all JSONL files under the active profiles, (re)parse files that
  // changed since the last index, and upsert their metadata. Returns the number
  // of files seen on disk this pass (the scan "scanned" count).
  async indexAll(activeProfiles: Profile[], options: ScanOptions): Promise<{ scanned: number }> {
    const log = getLogger();
    const tier = resolveTier(options.tier ?? "standard", options.tiers);

    const configDirs = activeProfiles.map((p) => ({
      projectsDir: getProjectsDir(p),
      account: p.id,
    }));

    const discovered = await discoverJsonlFiles(configDirs);
    let scanned = 0;

    const gitBranchMemo = new Map<string, string | null>();
    const resolveGitBranch = (projectPath: string): string | null => {
      if (gitBranchMemo.has(projectPath)) {
        return gitBranchMemo.get(projectPath) ?? null;
      }
      const branch = readGitBranch(projectPath);
      gitBranchMemo.set(projectPath, branch);
      return branch;
    };

    for (let i = 0; i < discovered.length; i += BATCH_SIZE) {
      const batch = discovered.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ filePath, account }) => {
          const meta = await this.indexFile(
            filePath,
            account,
            tier.name,
            options.tiers,
            resolveGitBranch,
          );
          return meta;
        }),
      );
      const kept = results.filter((m): m is ConversationMeta => m != null);
      if (kept.length > 0) options.onBatch?.(kept);
      scanned += batch.length;
      options.onProgress?.(scanned, discovered.length);
    }

    log.info({ scanned, indexed: this.conversations.count() }, "persistent: indexAll complete");
    return { scanned };
  }

  // (Re)index a single file. Classifies the change vs. the persisted cursor:
  // unchanged → return the stored summary; appended → resume the fold and read
  // only new bytes; reindex/force → fold from offset 0. Writes the summary +
  // cursor + reducer state in one transaction so a crash never leaves a
  // half-written row or an over-advanced cursor.
  async indexFile(
    filePath: string,
    account: string,
    tierName: string,
    customTiers: ScanOptions["tiers"],
    resolveGitBranch: (projectPath: string) => string | null,
    force = false,
  ): Promise<ConversationMeta | null> {
    const log = getLogger();
    const tier = resolveTier(tierName, customTiers);

    const existing = this.files.getByPath(filePath);
    const { change, stat } = classify(filePath, existing);

    if (change === "vanished" || !stat) {
      // File gone between discovery and indexing — treat as deleted.
      this.markDeleted(filePath);
      return null;
    }
    // Unchanged: serve the persisted summary without re-reading (unless a
    // caller forces a re-parse, e.g. refreshFile after a same-size edit).
    if (change === "unchanged" && !force) {
      return this.conversations.getBySourcePath(filePath);
    }

    // appended → resume the persisted fold from the cursor; reindex/force →
    // start fresh from offset 0. This is the incremental win: an append only
    // reads the newly-written bytes.
    const resume = change === "appended" && !force && existing?.reducer_state;
    const state: ReducerState = resume
      ? (JSON.parse(existing.reducer_state as string) as ReducerState)
      : initialReducerState();
    const startOffset = resume ? existing.last_indexed_offset : 0;
    const startLine = resume ? existing.last_indexed_line : 0;

    let result: TailReadResult;
    try {
      result = await tailReduce(filePath, startOffset, startLine, state, tier);
    } catch (err) {
      log.warn({ filePath, err }, "persistent: tail read failed");
      return null;
    }

    const meta = finalizeMeta(state, filePath, account, tier);
    if (!meta) {
      this.markDeleted(filePath);
      return null;
    }
    meta.gitBranch = resolveGitBranch(meta.projectPath);

    const fp = stat.size > 0 ? fingerprint(filePath, stat.size) : null;
    const fileId = this.files.ensure(filePath, account);
    const upsert = this.db.transaction(() => {
      this.conversations.upsert(fileId, meta);
      this.fts.upsert(meta);
      this.files.updateCursor(fileId, {
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        // Advance only to the last fully-parsed line; a trailing partial line
        // is left for the next pass.
        offset: result.newOffset,
        line: result.newLine,
        reducerState: JSON.stringify(state),
        fingerprint: fp,
        status: "active",
      });
    });
    upsert();

    log.debug(
      { filePath, change, bytesRead: result.newOffset - startOffset, msgs: meta.messageCount },
      "persistent: indexed file",
    );
    return meta;
  }

  private markDeleted(filePath: string): void {
    const existing = this.files.getByPath(filePath);
    if (!existing) return;
    const tx = this.db.transaction(() => {
      this.conversations.deleteByFileId(existing.id);
      this.fts.remove(filePath);
      this.files.setStatus(existing.id, "deleted");
    });
    tx();
  }

  // ── Query helpers (read straight from SQLite) ───────────────────────────

  allActive(): ConversationMeta[] {
    return this.conversations.allActive();
  }

  getByIdOrSession(id: string): ConversationMeta | null {
    return this.conversations.getByIdOrSession(id);
  }

  getAllBySessionId(sessionId: string): ConversationMeta[] {
    return this.conversations.getAllBySessionId(sessionId);
  }

  // Ranked metas matching the FTS query, best first. Empty query returns the
  // most recent conversations (mirroring the in-memory indexer's empty-query
  // behavior). Resolves each FTS hit to its active conversation row.
  searchMetas(query: string, limit: number): ConversationMeta[] {
    if (!query.trim()) {
      return this.conversations.recent(limit);
    }
    const paths = this.fts.search(query, limit);
    const metas: ConversationMeta[] = [];
    for (const path of paths) {
      const meta = this.conversations.getBySourcePath(path);
      if (meta) metas.push(meta);
    }
    return metas;
  }

  getProjects(): string[] {
    return this.conversations.distinctProjects();
  }
}
