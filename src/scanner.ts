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
import { parseConversation, parseMeta } from "./parser";
import { getProjectsDir, loadProfiles } from "./profiles";
import { resolveTier } from "./tiers";
import type {
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

  constructor(options?: { metadataCacheSize?: number; conversationCacheSize?: number }) {
    this.conversationLRU = new LRUCache<string, Conversation>(options?.conversationCacheSize ?? 5);
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const profiles = await this.resolveProfiles(options.profiles);
    const activeProfiles = profiles.filter((p) => p.enabled && p.scanHistory !== false);

    const tier = resolveTier(options.tier ?? "standard", options.tiers);

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
          } catch {
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

    if (Array.isArray(conversations)) {
      const limit = options.limit ?? 50;
      const offset = options.offset ?? 0;
      const paginated = applyPagination(conversations, limit, offset);
      return { conversations: paginated.items, total, scanned };
    }

    return { conversations, total, scanned };
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (this.indexer.getDocumentCount() === 0) {
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
    return results.slice(offset, offset + limit);
  }

  async getConversation(
    id: string,
    _options?: GetConversationOptions,
  ): Promise<Conversation | null> {
    const cached = this.conversationLRU.get(id);
    if (cached) return cached;

    const meta = this.metadataCache.get(id) ?? this.sessionIdIndex.get(id);
    if (!meta) return null;

    try {
      const conversation = await parseConversation(meta.filePath, meta.account);
      if (conversation) {
        this.conversationLRU.set(id, conversation);
      }
      return conversation;
    } catch {
      return null;
    }
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
