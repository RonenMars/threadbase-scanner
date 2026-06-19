import { statSync } from "fs";
import { discoverJsonlFiles } from "../discovery";
import { readGitBranch } from "../git";
import { getLogger } from "../logger";
import { parseMeta } from "../parser";
import { getProjectsDir } from "../profiles";
import { resolveTier } from "../tiers";
import type { ConversationMeta, Profile, ScanOptions } from "../types";
import { type DB, openDatabase } from "./db";
import { ConversationFilesRepo } from "./repositories/conversation-files.repo";
import { ConversationsRepo } from "./repositories/conversations.repo";

const BATCH_SIZE = 12;

// Persistent indexing engine. Owns the SQLite connection and the discover ->
// parse -> upsert pipeline. Query helpers return ConversationMeta straight from
// the DB so the scanner facade can run the existing filter/sort/view pipeline
// over them, guaranteeing parity with the in-memory path.
//
// Phase 2: still full-parses each changed file with parseMeta(). Byte-offset
// incremental indexing arrives in Phase 3 (the cursor/reducer columns already
// exist in the schema).
export class PersistentEngine {
  readonly db: DB;
  readonly files: ConversationFilesRepo;
  readonly conversations: ConversationsRepo;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.files = new ConversationFilesRepo(this.db);
    this.conversations = new ConversationsRepo(this.db);
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
      let branch = gitBranchMemo.get(projectPath);
      if (branch === undefined) {
        branch = readGitBranch(projectPath);
        gitBranchMemo.set(projectPath, branch);
      }
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

  // (Re)index a single file: skip when size+mtime are unchanged, otherwise
  // parse it fully and upsert. Writes the cursor/summary in one transaction so
  // a crash never leaves a half-written conversation row.
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

    let stat: { size: number; mtimeMs: number };
    try {
      const s = statSync(filePath);
      stat = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      // File vanished between discovery and indexing — treat as deleted.
      this.markDeleted(filePath);
      return null;
    }

    const existing = this.files.getByPath(filePath);
    if (
      !force &&
      existing &&
      existing.status === "active" &&
      existing.size_bytes === stat.size &&
      existing.mtime_ms === stat.mtimeMs
    ) {
      return this.conversations.getBySourcePath(filePath);
    }

    let meta: ConversationMeta | null = null;
    try {
      meta = await parseMeta(filePath, account, tier);
    } catch (err) {
      log.warn({ filePath, err }, "persistent: parseMeta threw");
      meta = null;
    }

    if (!meta || meta.messageCount === 0) {
      this.markDeleted(filePath);
      return null;
    }

    meta.gitBranch = resolveGitBranch(meta.projectPath);

    const fileId = this.files.ensure(filePath, account);
    const upsert = this.db.transaction(() => {
      this.conversations.upsert(fileId, meta as ConversationMeta);
      this.files.updateCursor(fileId, {
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        offset: stat.size,
        line: 0,
        reducerState: null,
        fingerprint: null,
        status: "active",
      });
    });
    upsert();

    return meta;
  }

  private markDeleted(filePath: string): void {
    const existing = this.files.getByPath(filePath);
    if (!existing) return;
    const tx = this.db.transaction(() => {
      this.conversations.deleteByFileId(existing.id);
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

  getProjects(): string[] {
    return this.conversations.distinctProjects();
  }
}
