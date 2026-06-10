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
import { getProjectsDir, loadProfiles } from "./profiles";
import { resolveTier } from "./tiers";
import type {
  ContentTier,
  Conversation,
  ConversationMeta,
  GetConversationOptions,
  GroupedConversations,
  Profile,
  ScanOptions,
  ScanResult,
  SearchOptions,
  SearchResult,
  TreeConversation,
} from "./types";

const BATCH_SIZE = 12;
const DEFAULT_CONFIG_PATH = "~/.config/threadbase-scanner";

export class ConversationScanner {
  private metadataCache: Map<string, ConversationMeta> = new Map();
  private conversationLRU: LRUCache<string, Conversation>;
  private sessionIdIndex: Map<string, ConversationMeta> = new Map();
  private projects: Set<string> = new Set();
  private indexer: SearchIndexer = new SearchIndexer();
  // Tier the most recent scan() ran with, so refreshFile() re-parses a single
  // file at the same content depth. Defaults to the standard tier.
  private lastTier: ContentTier = resolveTier("standard");

  constructor(options?: { metadataCacheSize?: number; conversationCacheSize?: number }) {
    this.conversationLRU = new LRUCache<string, Conversation>(options?.conversationCacheSize ?? 5);
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const log = getLogger();
    const startedAt = Date.now();
    const profiles = await this.resolveProfiles(options.profiles);
    const activeProfiles = profiles.filter((p) => p.enabled && p.scanHistory !== false);

    const tier = resolveTier(options.tier ?? "standard", options.tiers);
    this.lastTier = tier;

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
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ filePath, account }) => {
          try {
            const meta = await parseMeta(filePath, account, tier);
            if (meta) {
              meta.gitBranch = readGitBranch(meta.projectPath);
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

    // Apply filters
    let filtered = allMetas;
    if (options.include && options.include !== "all") {
      filtered = applyIncludeFilter(filtered, options.include);
    }
    if (options.project) {
      filtered = applyProjectFilter(filtered, options.project);
    }
    if (options.account) {
      filtered = applyAccountFilter(filtered, options.account);
    }
    if (options.since) {
      filtered = applySinceFilter(filtered, options.since);
    }

    filtered = applySort(filtered, options.sort ?? "recent");

    const total = filtered.length;
    const conversations = this.transformView(filtered, options);

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

    if (Array.isArray(conversations)) {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      const paginated = applyPagination(conversations, limit, offset);
      return { conversations: paginated.items, total, scanned };
    }

    return { conversations, total, scanned };
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const log = getLogger();
    log.debug({ query, indexSize: this.indexer.getDocumentCount() }, "search: start");

    if (this.indexer.getDocumentCount() === 0) {
      log.debug("search: index empty, triggering scan");
      await this.scan({ ...options, limit: undefined, offset: undefined });
    }

    let results = this.indexer.search(query, {
      fields: options.fields,
      limit: (options.limit ?? 50) * 2,
    });

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

    const meta = this.metadataCache.get(id) ?? this.sessionIdIndex.get(id);
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
    return this.metadataCache;
  }

  getProjects(): string[] {
    const normalized = new Set<string>();
    for (const p of this.projects) {
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
