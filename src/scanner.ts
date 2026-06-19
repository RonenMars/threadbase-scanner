import { statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { LRUCache } from "./cache";
import { discoverJsonlFiles } from "./discovery";
import {
  applyAccountFilter,
  applyIncludeFilter,
  applyPagination,
  applyProjectFilter,
  applySinceFilter,
  applySort,
  parseSinceCutoff,
} from "./filters";
import { readGitBranch } from "./git";
import { SearchIndexer } from "./indexer";
import { getLogger } from "./logger";
import { parseConversation, parseMeta } from "./parser";
import { PersistentEngine } from "./persistent/index-engine";
import { getProjectsDir, loadProfiles } from "./profiles";
import { generateMatches } from "./search-matches";
import { resolveTier } from "./tiers";
import type {
  ContentTier,
  Conversation,
  ConversationMeta,
  ConversationPage,
  GetConversationOptions,
  GetConversationPageOptions,
  GroupedConversations,
  Profile,
  ScanOptions,
  ScanResult,
  SearchOptions,
  SearchResult,
  SingleFilePage,
  TreeConversation,
} from "./types";

const BATCH_SIZE = 12;
const DEFAULT_CONFIG_PATH = "~/.config/threadbase-scanner";

// Default persistent-index location. Overridable via TB_SCANNER_DB (used by
// tests for isolation, and handy for pointing at an alternate DB in ops).
function defaultDbPath(): string {
  return process.env.TB_SCANNER_DB ?? join(homedir(), ".config", "threadbase-scanner", "index.db");
}

export interface PersistentConfig {
  dbPath?: string;
}

export interface ConversationScannerOptions {
  metadataCacheSize?: number;
  conversationCacheSize?: number;
  // SQLite-backed persistent index. Enabled by default (at DEFAULT_DB_PATH).
  // Pass `false` for the legacy in-memory path (no native dependency, no DB
  // file). Pass `{ dbPath }` to override the database location.
  persistent?: false | PersistentConfig;
}

export class ConversationScanner {
  private metadataCache: Map<string, ConversationMeta> = new Map();
  private conversationLRU: LRUCache<string, Conversation>;
  private sessionIdIndex: Map<string, ConversationMeta> = new Map();
  private projects: Set<string> = new Set();
  private indexer: SearchIndexer = new SearchIndexer();
  // Tier the most recent scan() ran with, so refreshFile() re-parses a single
  // file at the same content depth. Defaults to the standard tier.
  private lastTier: ContentTier = resolveTier("standard");

  // null when persistent mode is disabled (legacy in-memory path). Lazily
  // opened on first use so merely constructing a scanner never touches disk.
  private readonly dbPath: string | null;
  private engineInstance: PersistentEngine | null = null;

  constructor(options?: ConversationScannerOptions) {
    this.conversationLRU = new LRUCache<string, Conversation>(options?.conversationCacheSize ?? 5);
    if (options?.persistent === false) {
      this.dbPath = null;
    } else {
      this.dbPath = options?.persistent?.dbPath ?? defaultDbPath();
    }
  }

  private get persistent(): boolean {
    return this.dbPath !== null;
  }

  private engine(): PersistentEngine {
    if (!this.engineInstance) {
      this.engineInstance = new PersistentEngine(this.dbPath as string);
    }
    return this.engineInstance;
  }

  // Release the SQLite connection. No-op in legacy mode. Safe to call repeatedly.
  close(): void {
    this.engineInstance?.close();
    this.engineInstance = null;
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const profiles = await this.resolveProfiles(options.profiles);
    const activeProfiles = profiles.filter((p) => p.enabled && p.scanHistory !== false);
    this.lastTier = resolveTier(options.tier ?? "standard", options.tiers);

    if (this.persistent) {
      return this.scanPersistent(activeProfiles, options);
    }
    return this.scanInMemory(activeProfiles, options);
  }

  // SQLite-backed scan: (re)index changed files into the DB, then query all
  // active metas and run the identical filter/sort/view/paginate pipeline as
  // the in-memory path — guaranteeing an identical ScanResult shape.
  private async scanPersistent(
    activeProfiles: Profile[],
    options: ScanOptions,
  ): Promise<ScanResult> {
    const log = getLogger();
    const startedAt = Date.now();
    const engine = this.engine();

    const { scanned } = await engine.indexAll(activeProfiles, options);
    const allMetas = engine.allActive();

    const { conversations, total } = this.finalize(allMetas, options);
    log.info(
      { scanned, kept: allMetas.length, filteredTotal: total, elapsedMs: Date.now() - startedAt },
      "scan: complete (persistent)",
    );
    return { conversations, total, scanned };
  }

  // Apply include/project/account/since filters, sort, view transform, and
  // pagination. Shared by both backends so results never diverge.
  private finalize(
    allMetas: ConversationMeta[],
    options: ScanOptions,
  ): { conversations: ScanResult["conversations"]; total: number } {
    let filtered = allMetas;
    if (options.include && options.include !== "all") {
      filtered = applyIncludeFilter(filtered, options.include);
    }
    if (options.project) filtered = applyProjectFilter(filtered, options.project);
    if (options.account) filtered = applyAccountFilter(filtered, options.account);
    if (options.since) filtered = applySinceFilter(filtered, options.since);

    filtered = applySort(filtered, options.sort ?? "recent");
    const total = filtered.length;
    const conversations = this.transformView(filtered, options);

    if (Array.isArray(conversations)) {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      return { conversations: applyPagination(conversations, limit, offset).items, total };
    }
    return { conversations, total };
  }

  private async scanInMemory(activeProfiles: Profile[], options: ScanOptions): Promise<ScanResult> {
    const log = getLogger();
    const startedAt = Date.now();
    const tier = this.lastTier;

    log.info(
      {
        activeProfiles: activeProfiles.length,
        tier: tier.name,
        sort: options.sort ?? "recent",
        include: options.include ?? "all",
        view: options.view ?? "flat",
      },
      "scan: start",
    );

    // Clear caches
    this.metadataCache.clear();
    this.conversationLRU.clear();
    this.sessionIdIndex.clear();
    this.projects.clear();
    this.indexer.clear();

    const configDirs = activeProfiles.map((p) => ({
      projectsDir: getProjectsDir(p),
      account: p.id,
    }));

    const files = await discoverJsonlFiles(configDirs);
    const totalFiles = files.length;
    let scanned = 0;
    let parseFailures = 0;

    const allMetas: ConversationMeta[] = [];
    // Memoize git-branch lookups per project path for the duration of this
    // scan. readGitBranch walks the filesystem for .git/HEAD; without this it
    // runs once per conversation (thousands of times) even though there are
    // only a handful of distinct project roots. Scoped to one scan() call —
    // branches can change between scans, so a longer-lived memo would go stale.
    const gitBranchMemo = new Map<string, string | null>();
    const resolveGitBranch = (projectPath: string): string | null => {
      let branch = gitBranchMemo.get(projectPath);
      if (branch === undefined) {
        branch = readGitBranch(projectPath);
        gitBranchMemo.set(projectPath, branch);
      }
      return branch;
    };
    const { statCache } = options;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ filePath, account }) => {
          if (statCache) {
            const cached = statCache.get(filePath);
            if (cached) {
              try {
                const s = statSync(filePath);
                if (s.mtimeMs === cached.stat.mtimeMs && s.size === cached.stat.size) {
                  return cached.meta;
                }
              } catch {
                // file disappeared — fall through to parseMeta which will return null
              }
            }
          }
          try {
            const meta = await parseMeta(filePath, account, tier);
            if (meta) {
              meta.gitBranch = resolveGitBranch(meta.projectPath);
            }
            return meta;
          } catch (err) {
            parseFailures++;
            log.warn({ filePath, account, err }, "scan: parseMeta threw");
            return null;
          }
        }),
      );

      const batchMetas: ConversationMeta[] = [];
      for (const meta of results) {
        if (meta && meta.messageCount > 0) {
          this.metadataCache.set(meta.id, meta);
          this.sessionIdIndex.set(meta.sessionId, meta);
          this.projects.add(meta.projectPath);
          allMetas.push(meta);
          batchMetas.push(meta);
          this.indexer.addDocument(meta);
        }
      }

      if (batchMetas.length > 0) {
        options.onBatch?.(batchMetas);
      }

      scanned += batch.length;
      log.debug({ scanned, totalFiles, batchKept: batchMetas.length }, "scan: batch complete");
      options.onProgress?.(scanned, totalFiles);
    }

    const { conversations, total } = this.finalize(allMetas, options);

    const elapsedMs = Date.now() - startedAt;
    log.info(
      {
        totalFiles,
        scanned,
        kept: allMetas.length,
        filteredTotal: total,
        parseFailures,
        elapsedMs,
      },
      "scan: complete",
    );

    return { conversations, total, scanned };
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const log = getLogger();
    log.debug({ query, indexSize: this.indexer.getDocumentCount() }, "search: start");

    let results: SearchResult[];
    if (this.persistent) {
      // SQLite FTS5 is the persistent search engine. Index once if the DB is
      // empty (mirroring the in-memory "scan on first search" contract), then
      // query FTS directly — no in-memory index to warm.
      const engine = this.engine();
      if (engine.conversations.count() === 0) {
        log.debug("search: persistent index empty, triggering scan");
        const profiles = await this.resolveProfiles(options.profiles);
        const activeProfiles = profiles.filter((p) => p.enabled && p.scanHistory !== false);
        await engine.indexAll(activeProfiles, { ...options, limit: undefined, offset: undefined });
      }
      const metas = engine.searchMetas(query, (options.limit ?? 50) * 2);
      results = query.trim()
        ? metas.map((meta) => ({ meta, score: 1, matches: generateMatches(meta, query) }))
        : metas.map((meta) => ({
            meta,
            score: 1,
            matches: [{ field: "timestamp", snippet: meta.preview }],
          }));
    } else {
      if (this.indexer.getDocumentCount() === 0) {
        log.debug("search: index empty, triggering scan");
        await this.scan({ ...options, limit: undefined, offset: undefined });
      }
      results = this.indexer.search(query, {
        fields: options.fields,
        limit: (options.limit ?? 50) * 2,
      });
    }

    if (options.include && options.include !== "all") {
      results = results.filter((r) => {
        switch (options.include) {
          case "conversations":
            return !r.meta.isSubagent && !r.meta.isTeammate;
          case "subagents":
            return r.meta.isSubagent;
          case "teammates":
            return r.meta.isTeammate;
          default:
            return true;
        }
      });
    }
    if (options.project) {
      const lower = options.project.toLowerCase();
      results = results.filter(
        (r) =>
          r.meta.projectPath.toLowerCase().includes(lower) ||
          r.meta.projectName.toLowerCase().includes(lower),
      );
    }
    if (options.account) {
      results = results.filter((r) => r.meta.account === options.account);
    }
    if (options.since) {
      const cutoff = parseSinceCutoff(options.since);
      results = results.filter((r) => new Date(r.meta.timestamp).getTime() >= cutoff.getTime());
    }

    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const sliced = results.slice(offset, offset + limit);
    log.debug({ query, matched: results.length, returned: sliced.length }, "search: complete");
    return sliced;
  }

  async getConversation(
    id: string,
    _options?: GetConversationOptions,
  ): Promise<Conversation | null> {
    const log = getLogger();
    const cached = this.conversationLRU.get(id);
    if (cached) {
      log.debug({ id }, "getConversation: cache hit");
      return cached;
    }

    const meta = this.persistent
      ? this.engine().getByIdOrSession(id)
      : (this.metadataCache.get(id) ?? this.sessionIdIndex.get(id));
    if (!meta) {
      log.debug({ id }, "getConversation: not found in metadata");
      return null;
    }

    log.debug({ id, filePath: meta.filePath }, "getConversation: cache miss, parsing");
    try {
      const conversation = await parseConversation(meta.filePath, meta.account);
      if (conversation) {
        this.conversationLRU.set(id, conversation);
      }
      return conversation;
    } catch (err) {
      log.warn({ id, filePath: meta.filePath, err }, "getConversation: parse failed");
      return null;
    }
  }

  // Return one bounded window of a conversation's messages plus the total
  // message count, so a caller can serve the last page and scroll back without
  // holding the whole conversation itself.
  //
  // The window is `[max(0, beforeIndex - limit), beforeIndex)` in chronological
  // order; `beforeIndex` defaults to `total` (the newest page). `fromIndex` is
  // the window's start index, so the caller can derive `has_more_older`
  // (fromIndex > 0). Returns null when the id can't be resolved/parsed — the
  // same contract as getConversation.
  //
  // Strategy: parse-once-then-slice. This delegates to getConversation, which
  // parses the full conversation and caches it in conversationLRU, then slices
  // the window. Message indices are therefore identical to a full
  // parseConversation() by construction (same parse, same messages array).
  // Repeated page requests for the same id reuse the single cached parse. The
  // bounded-memory win (not holding all messages) is deferred — see
  // docs/plans/2026-06-10-paged-conversation-parse.md.
  async getConversationPage(
    id: string,
    options: GetConversationPageOptions,
  ): Promise<ConversationPage | null> {
    const conversation = await this.getConversation(id);
    if (!conversation) return null;

    const { messages } = conversation;
    const total = messages.length;
    const { limit } = options;
    const beforeIndex = options.beforeIndex ?? total;

    const fromIndex = Math.max(0, beforeIndex - limit);
    const window = messages.slice(fromIndex, beforeIndex);

    return { messages: window, total, fromIndex };
  }

  // Parse one JSONL file directly and slice a page window — without any prior
  // scan() or metadata index. This is the cold-start fast path: a single
  // conversation can be served from one file parse (~ms) instead of waiting
  // for a full filesystem scan. The window is the same
  // `[max(0, beforeIndex - limit), beforeIndex)` slice as getConversationPage,
  // and the parsed Conversation is returned alongside so the caller can build
  // the response meta (projectPath, timestamp, messageCount, …) without a
  // second parse. Returns null when the file can't be parsed. `account` only
  // feeds the conversation's account field; "default" is the single-profile
  // fallback, matching refreshFile.
  async parseSingleFilePage(
    filePath: string,
    account: string | undefined,
    options: GetConversationPageOptions,
  ): Promise<SingleFilePage | null> {
    const conversation = await parseConversation(filePath, account ?? "default");
    if (!conversation) return null;

    const { messages } = conversation;
    const total = messages.length;
    const { limit } = options;
    const beforeIndex = options.beforeIndex ?? total;

    const fromIndex = Math.max(0, beforeIndex - limit);
    const window = messages.slice(fromIndex, beforeIndex);

    return { messages: window, total, fromIndex, conversation };
  }

  // Re-parse a single JSONL file and update every in-memory index in place —
  // metadata cache, sessionId index, project set, search index — and evict the
  // file's parsed conversation from the LRU so the next getConversation()
  // re-reads it. This lets a long-lived scanner stay current with a file that
  // grew after the initial scan() without paying for a full rescan.
  //
  // `account` defaults to the account already recorded for this file (the id
  // is the file path), falling back to "default" for a file the scanner has
  // not seen before. Returns the fresh ConversationMeta, or null when the file
  // no longer parses (missing/empty) — in which case any prior entry for it is
  // dropped from all indexes.
  async refreshFile(filePath: string, account?: string): Promise<ConversationMeta | null> {
    const log = getLogger();

    if (this.persistent) {
      const engine = this.engine();
      const previous = engine.getByIdOrSession(filePath);
      const resolvedAccount = account ?? previous?.account ?? "default";
      const evict = (m: ConversationMeta | null) => {
        if (!m) return;
        this.conversationLRU.delete(m.id);
        this.conversationLRU.delete(m.sessionId);
      };
      evict(previous);
      const meta = await engine.indexFile(
        filePath,
        resolvedAccount,
        this.lastTier.name,
        undefined,
        readGitBranch,
        true,
      );
      evict(meta);
      log.debug({ filePath, kept: !!meta }, "refreshFile: updated persistent index");
      return meta;
    }

    const previous = this.metadataCache.get(filePath);
    const resolvedAccount = account ?? previous?.account ?? "default";

    let meta: ConversationMeta | null = null;
    try {
      meta = await parseMeta(filePath, resolvedAccount, this.lastTier);
    } catch (err) {
      log.warn({ filePath, err }, "refreshFile: parseMeta threw");
      meta = null;
    }

    // The LRU is keyed by the id used at getConversation() time, which can be
    // either the file-path id or the sessionId — evict both for the prior and
    // refreshed metas so no stale parse survives.
    const evict = (m: ConversationMeta | undefined | null) => {
      if (!m) return;
      this.conversationLRU.delete(m.id);
      this.conversationLRU.delete(m.sessionId);
    };
    evict(previous);
    evict(meta);

    if (!meta || meta.messageCount === 0) {
      if (previous) {
        this.metadataCache.delete(previous.id);
        this.sessionIdIndex.delete(previous.sessionId);
        this.indexer.removeDocument(previous.id);
      }
      log.debug({ filePath }, "refreshFile: dropped (no parseable messages)");
      return null;
    }

    meta.gitBranch = readGitBranch(meta.projectPath);

    // A re-parse can change the sessionId mapping; clear the old one first.
    if (previous && previous.sessionId !== meta.sessionId) {
      this.sessionIdIndex.delete(previous.sessionId);
    }
    this.metadataCache.set(meta.id, meta);
    this.sessionIdIndex.set(meta.sessionId, meta);
    this.projects.add(meta.projectPath);
    if (previous) {
      this.indexer.updateDocument(meta);
    } else {
      this.indexer.addDocument(meta);
    }

    log.debug(
      { filePath, messageCount: meta.messageCount },
      "refreshFile: updated in-memory indexes",
    );
    return meta;
  }

  getMetadataCache(): Map<string, ConversationMeta> {
    if (this.persistent) {
      const map = new Map<string, ConversationMeta>();
      for (const meta of this.engine().allActive()) map.set(meta.id, meta);
      return map;
    }
    return this.metadataCache;
  }

  // Collision-safe sessionId lookup. session_id is NOT unique (the parser falls
  // back to the file basename, and resumed/subagent sessions repeat ids), so
  // getConversation(sessionId) is a convenience that resolves to one match;
  // this returns every active conversation sharing the id, newest first.
  getConversationsBySessionId(sessionId: string): ConversationMeta[] {
    if (this.persistent) {
      return this.engine().getAllBySessionId(sessionId);
    }
    const hit = this.sessionIdIndex.get(sessionId);
    return hit ? [hit] : [];
  }

  getProjects(): string[] {
    const source = this.persistent ? this.engine().getProjects() : this.projects;
    const normalized = new Set<string>();
    for (const p of source) {
      normalized.add(p.replace(/\/+$/, ""));
    }
    return Array.from(normalized).sort();
  }

  private async resolveProfiles(profiles?: Profile[]): Promise<Profile[]> {
    if (profiles && profiles.length > 0) return profiles;
    return loadProfiles(DEFAULT_CONFIG_PATH);
  }

  private transformView(
    metas: ConversationMeta[],
    options: ScanOptions,
  ): ConversationMeta[] | TreeConversation[] | GroupedConversations {
    switch (options.view) {
      case "tree":
        return this.toTree(metas);
      case "grouped":
        return this.toGrouped(metas);
      default:
        return metas;
    }
  }

  private toTree(metas: ConversationMeta[]): TreeConversation[] {
    const parents: TreeConversation[] = [];
    const subagents: ConversationMeta[] = [];

    for (const meta of metas) {
      if (meta.isSubagent) {
        subagents.push(meta);
      } else {
        parents.push({ ...meta, subagents: [] });
      }
    }

    const parentById = new Map(parents.map((p) => [p.id, p]));
    for (const sub of subagents) {
      const parent = sub.parentSessionId ? parentById.get(sub.parentSessionId) : undefined;
      if (parent) {
        parent.subagents.push(sub);
      } else {
        parents.push({ ...sub, subagents: [] });
      }
    }

    return parents;
  }

  private toGrouped(metas: ConversationMeta[]): GroupedConversations {
    const groups: GroupedConversations = {};
    for (const meta of metas) {
      const key = meta.teamName || "_default";
      if (!groups[key]) groups[key] = [];
      groups[key].push(meta);
    }
    return groups;
  }
}
