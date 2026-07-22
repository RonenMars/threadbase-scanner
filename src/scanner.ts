import { EventEmitter } from "events";
import { closeSync, openSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { LRUCache } from "./cache";
import { canonicalPath } from "./canonical-path";
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
import {
  type CachedConversation,
  extendConversation,
  parseConversationResumable,
} from "./persistent/conversation-stream";
import { classify } from "./persistent/cursor";
import { PersistentEngine } from "./persistent/index-engine";
import { getProjectsDir, loadProfiles } from "./profiles";
import { CodexCliProvider, parseCodexConversation } from "./providers/codex-cli";
import { parseMetaWithProvider } from "./providers/parse";
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_CLI_PROVIDER,
  type ScannerProvider,
} from "./providers/provider";
import { ThreadbaseProvider } from "./providers/threadbase";
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
import { FileWatcher } from "./watcher/file-watcher";
import { type IndexJob, IndexQueue } from "./watcher/index-queue";

const BATCH_SIZE = 12;
const DEFAULT_CONFIG_PATH = "~/.config/threadbase-scanner";

// Default persistent-index location. Overridable via TB_SCANNER_DB (used by
// tests for isolation, and handy for pointing at an alternate DB in ops).
function defaultDbPath(): string {
  return process.env.TB_SCANNER_DB ?? join(homedir(), ".config", "threadbase-scanner", "index.db");
}

export interface PersistentConfig {
  dbPath?: string;
  // Write a portable <file>.idx.json sidecar next to each indexed JSONL for
  // debugging/portability/recovery. Off by default. SQLite stays canonical.
  sidecar?: boolean;
}

export interface ConversationScannerOptions {
  metadataCacheSize?: number;
  conversationCacheSize?: number;
  // SQLite-backed persistent index. Enabled by default (at DEFAULT_DB_PATH).
  // Pass `false` for the legacy in-memory path (no native dependency, no DB
  // file). Pass `{ dbPath }` to override the database location.
  persistent?: false | PersistentConfig;
}

export interface WatchOptions {
  profiles?: Profile[];
  // Watcher debounce window (ms). Default 400.
  debounceMs?: number;
  // Periodic full rescan as a correctness fallback for missed FS events.
  // Default 60_000ms; set 0 to disable.
  periodicMs?: number;
}

// Emitted after the index changes for one file. `meta` is the fresh metadata,
// or null when the file was removed/emptied (deleted from the index).
export interface ScannerChangeEvent {
  filePath: string;
  account: string;
  meta: ConversationMeta | null;
  reason: IndexJob["reason"];
}

export class ConversationScanner {
  private metadataCache: Map<string, ConversationMeta> = new Map();
  // Parsed conversations plus (persistent claude-code entries only) the resume
  // point that lets refreshFile extend them in place when the file grows.
  private conversationLRU: LRUCache<string, CachedConversation>;
  // session_id is NOT unique, so this maps a sessionId to every active meta that
  // carries it. Resolution picks deterministically (newest timestamp, then path
  // ascending) so dropping one file never hides another with the same id.
  private sessionIdIndex: Map<string, ConversationMeta[]> = new Map();
  private projects: Set<string> = new Set();
  private indexer: SearchIndexer = new SearchIndexer();
  // Tier the most recent scan() ran with, so refreshFile() re-parses a single
  // file at the same content depth. Defaults to the standard tier.
  private lastTier: ContentTier = resolveTier("standard");

  // null when persistent mode is disabled (legacy in-memory path). Lazily
  // opened on first use so merely constructing a scanner never touches disk.
  private readonly dbPath: string | null;
  private readonly sidecarEnabled: boolean;
  private engineInstance: PersistentEngine | null = null;
  // The most recent scan()'s promise while it is still running, or null when
  // idle. close() awaits it before closing the SQLite handle so a fire-and-
  // forget scan can't have its DB shut mid-indexAll ("database connection is
  // not open"). Tracks the latest scan only — concurrent scans on one instance
  // aren't a supported pattern (a single writer DB), and the latest resolving
  // implies earlier ones already settled in practice.
  private inFlightScan: Promise<unknown> | null = null;

  private emitter = new EventEmitter();
  private watcher: FileWatcher | null = null;
  private queue: IndexQueue | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  // The in-flight periodicReconcile() job, if one is mid-run. unwatch() awaits
  // it before dropping the queue/engine so its post-await engine.files access
  // can't hit a closed DB (the watch-mode half of Bug #4).
  private inFlightReconcile: Promise<void> | null = null;

  constructor(options?: ConversationScannerOptions) {
    this.conversationLRU = new LRUCache<string, CachedConversation>(
      options?.conversationCacheSize ?? 5,
    );
    if (options?.persistent === false) {
      this.dbPath = null;
      this.sidecarEnabled = false;
    } else {
      this.dbPath = options?.persistent?.dbPath ?? defaultDbPath();
      this.sidecarEnabled = options?.persistent?.sidecar ?? false;
    }
  }

  private get persistent(): boolean {
    return this.dbPath !== null;
  }

  private engine(): PersistentEngine {
    if (!this.engineInstance) {
      this.engineInstance = new PersistentEngine(this.dbPath as string, {
        sidecar: this.sidecarEnabled,
      });
    }
    return this.engineInstance;
  }

  // Release the SQLite connection. No-op in legacy mode. Safe to call
  // repeatedly. Awaits watcher teardown AND any in-flight scan before closing
  // the DB handle, so a fire-and-forget scan() can never have its connection
  // shut mid-indexAll() ("database connection is not open"). This is why close()
  // is async — callers should await it during shutdown. (Scanner review Bug #4.)
  async close(): Promise<void> {
    if (this.watcher || this.queue || this.periodicTimer) await this.unwatch();
    // Let any running scan finish touching the DB first. Swallow its result/
    // rejection here — the caller that started the scan owns its outcome; close()
    // only needs it to stop using the handle before we close it.
    if (this.inFlightScan) {
      try {
        await this.inFlightScan;
      } catch {
        // scan failed on its own; close() proceeds to release the handle
      }
    }
    this.engineInstance?.close();
    this.engineInstance = null;
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    // Track this scan so close() can await it before shutting the DB handle.
    // Cleared on settle — but only if it's still the current one (a newer scan
    // may have replaced it). Errors propagate to the caller unchanged.
    const promise = this.runScan(options);
    this.inFlightScan = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlightScan === promise) this.inFlightScan = null;
    }
  }

  private async runScan(options: ScanOptions): Promise<ScanResult> {
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

    const files = await this.discoverWithProviders(activeProfiles, options);
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
        batch.map(async ({ filePath, account, provider }) => {
          if (statCache) {
            const cached = statCache.get(filePath);
            if (cached) {
              try {
                const s = statSync(filePath);
                if (s.mtimeMs === cached.stat.mtimeMs && s.size === cached.stat.size) {
                  return cached.meta;
                }
              } catch {
                // file disappeared — fall through to parse which will return null
              }
            }
          }
          try {
            const meta = await parseMetaWithProvider(provider, filePath, account, tier);
            // The provider may already know its branch (Codex reads it from
            // session_meta). Only walk the filesystem when it doesn't.
            if (meta && meta.gitBranch === null && meta.projectPath) {
              meta.gitBranch = resolveGitBranch(meta.projectPath);
            }
            return meta;
          } catch (err) {
            parseFailures++;
            log.warn({ filePath, account, provider: provider.name, err }, "scan: parse threw");
            return null;
          }
        }),
      );

      const batchMetas: ConversationMeta[] = [];
      for (const meta of results) {
        if (meta && meta.messageCount > 0) {
          this.metadataCache.set(meta.id, meta);
          this.addToSessionIndex(meta);
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
    if (options.provider) {
      results = results.filter(
        (r) => (r.meta.provider ?? CLAUDE_CODE_PROVIDER) === options.provider,
      );
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
    // Canonicalize the file-path form of the id so a native (join/watcher) and a
    // forward-slash (fast-glob) spelling of the same file resolve to one entry.
    // A sessionId (no separators) is unaffected.
    const cid = canonicalPath(id);
    const cached = this.conversationLRU.get(cid);
    if (cached) {
      log.debug({ id }, "getConversation: cache hit");
      return cached.conversation;
    }

    const meta = this.persistent
      ? this.engine().getByIdOrSession(cid)
      : (this.metadataCache.get(cid) ?? this.resolveSessionId(cid));
    if (!meta) {
      log.debug({ id }, "getConversation: not found in metadata");
      return null;
    }

    log.debug({ id, filePath: meta.filePath }, "getConversation: cache miss, parsing");
    try {
      // Persistent claude-code files parse through the resumable streaming fold
      // so the cached entry carries its resume point — refreshFile can then
      // extend it with only the appended bytes instead of evicting it. Codex
      // and legacy-mode parses stay on their existing parsers (no resume state;
      // a refresh evicts them as before).
      if (this.persistent && meta.provider !== CODEX_CLI_PROVIDER) {
        const parsed = await parseConversationResumable(meta.filePath, meta.account);
        if (parsed) this.conversationLRU.set(cid, parsed);
        return parsed?.conversation ?? null;
      }
      const conversation =
        meta.provider === CODEX_CLI_PROVIDER
          ? await parseCodexConversation(meta.filePath, meta.account)
          : await parseConversation(meta.filePath, meta.account);
      if (conversation) {
        this.conversationLRU.set(cid, { conversation });
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
  // Persistent mode: a true bounded read — the engine seeks from the nearest
  // checkpoint and parses only the requested window (checkpoints are built
  // lazily for large conversations). Windowed message indices are proven
  // identical to parseConversation().messages.slice(...) by the paged-reader
  // equivalence test.
  //
  // Legacy mode: parse-once-then-slice via getConversation (cached in the LRU),
  // which is identical by construction.
  async getConversationPage(
    id: string,
    options: GetConversationPageOptions,
  ): Promise<ConversationPage | null> {
    if (this.persistent) {
      return this.engine().getPage(canonicalPath(id), options);
    }

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
  //
  // Single-flighted per path: concurrent callers (stacked client retries, a
  // watcher tick racing a caller) await the one in-flight refresh instead of
  // each re-reading the file.
  private readonly refreshesInFlight = new Map<string, Promise<ConversationMeta | null>>();

  refreshFile(filePath: string, account?: string): Promise<ConversationMeta | null> {
    // Key every refresh off the canonical path so a fast-glob (forward slash)
    // and a watcher/join (native) spelling of the same file share one in-flight
    // refresh and hit the same stored row.
    const cpath = canonicalPath(filePath);
    const inFlight = this.refreshesInFlight.get(cpath);
    if (inFlight) return inFlight;
    const refresh = this.doRefreshFile(cpath, account).finally(() => {
      if (this.refreshesInFlight.get(cpath) === refresh) {
        this.refreshesInFlight.delete(cpath);
      }
    });
    this.refreshesInFlight.set(cpath, refresh);
    return refresh;
  }

  private async doRefreshFile(
    filePath: string,
    account?: string,
  ): Promise<ConversationMeta | null> {
    const log = getLogger();

    if (this.persistent) {
      const engine = this.engine();
      const previous = engine.getByIdOrSession(filePath);
      const resolvedAccount = account ?? previous?.account ?? "default";
      // Resolve the provider so a Codex file refreshes through the Codex reducer
      // rather than the Threadbase tail-read. Prefer stored metadata; fall back
      // to a structural sniff for a file the index hasn't seen yet.
      const provider = await this.resolveProviderForFile(filePath, previous);
      // force=false: let classify() decide. It already distinguishes
      // unchanged/appended/reindex/vanished correctly (including the
      // replace-with-larger-file case, cursor.ts), so the watcher's live-append
      // path resumes from the byte cursor instead of reparsing the whole file
      // on every debounced tick.
      const { meta, change } = await engine.indexFile(
        filePath,
        resolvedAccount,
        this.lastTier.name,
        undefined,
        readGitBranch,
        false,
        provider,
      );

      // Cached parses are keyed by whatever id getConversation() was asked for
      // — the file-path id or the sessionId — so collect every candidate key.
      const cacheKeys = new Set<string>();
      for (const m of [previous, meta]) {
        if (m) {
          cacheKeys.add(m.id);
          cacheKeys.add(m.sessionId);
        }
      }
      if (!meta || change === "reindex" || change === "vanished") {
        // Truncated/replaced/gone: the cached parse no longer matches the
        // bytes on disk — drop it so the next read re-parses.
        for (const key of cacheKeys) this.conversationLRU.delete(key);
      } else if (change === "appended") {
        // The file only grew: advance any cached parse by folding just the
        // appended bytes, leaving the LRU warm instead of evicting it.
        await this.extendCachedConversations(cacheKeys, filePath, meta.account);
      }
      // unchanged → the cached parse is still valid; leave it warm.

      log.debug({ filePath, change, kept: !!meta }, "refreshFile: updated persistent index");
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
        this.removeFromSessionIndex(previous);
        this.indexer.removeDocument(previous.id);
      }
      log.debug({ filePath }, "refreshFile: dropped (no parseable messages)");
      return null;
    }

    meta.gitBranch = readGitBranch(meta.projectPath);

    // A re-parse can change the sessionId mapping; clear the old entry first so
    // we don't leave this file listed under a stale sessionId.
    if (previous) this.removeFromSessionIndex(previous);
    this.metadataCache.set(meta.id, meta);
    this.addToSessionIndex(meta);
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

  // Advance every cached parse of an appended file by folding only the new
  // bytes through the conversation reducer — the in-memory analogue of the
  // persisted metadata fold. Entries without resume state (Codex) and entries
  // whose extension fails are evicted so the next read re-parses from scratch.
  private async extendCachedConversations(
    cacheKeys: Set<string>,
    filePath: string,
    account: string,
  ): Promise<void> {
    // Multiple keys can point at the same wrapper (path id + sessionId) —
    // group by wrapper so each cached parse is extended exactly once.
    const wrappers = new Map<CachedConversation, string[]>();
    for (const key of cacheKeys) {
      const wrapper = this.conversationLRU.get(key);
      if (!wrapper) continue;
      const keys = wrappers.get(wrapper) ?? [];
      keys.push(key);
      wrappers.set(wrapper, keys);
    }
    for (const [wrapper, keys] of wrappers) {
      if (!wrapper.resume) {
        for (const key of keys) this.conversationLRU.delete(key);
        continue;
      }
      try {
        const extended = await extendConversation(
          wrapper.conversation,
          wrapper.resume,
          filePath,
          account,
        );
        // Mutate the wrapper in place so every key holding it sees the update.
        wrapper.conversation = extended.conversation;
        wrapper.resume = extended.resume;
      } catch (err) {
        getLogger().warn({ filePath, err }, "refreshFile: cache extension failed, evicting");
        for (const key of keys) this.conversationLRU.delete(key);
      }
    }
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
    return this.sortBySessionPriority(this.sessionIdIndex.get(sessionId) ?? []);
  }

  getProjects(): string[] {
    const source = this.persistent ? this.engine().getProjects() : this.projects;
    const normalized = new Set<string>();
    for (const p of source) {
      normalized.add(p.replace(/\/+$/, ""));
    }
    return Array.from(normalized).sort();
  }

  // ── File watching (persistent mode only) ────────────────────────────────

  // Subscribe to index changes. Events: "change" → ScannerChangeEvent,
  // "error" → Error. Returns this for chaining.
  on(event: "change", listener: (e: ScannerChangeEvent) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  // Start watching the active profiles' project dirs. A filesystem watcher
  // feeds debounced, path-deduplicated index jobs through a single-writer
  // queue; a periodic full rescan backstops any events the watcher misses
  // (sleep/wake, network FS, restarts). Emits "change" per indexed file.
  // Persistent mode only — throws in legacy mode (no durable index to update).
  async watch(options: WatchOptions = {}): Promise<void> {
    if (!this.persistent) {
      throw new Error("watch() requires persistent mode; construct with persistent enabled");
    }
    if (this.watcher) return; // already watching

    const profiles = await this.resolveProfiles(options.profiles);
    const activeProfiles = profiles.filter((p) => p.enabled && p.scanHistory !== false);

    this.queue = new IndexQueue(async (job) => {
      try {
        // Create/change and delete both route through refreshFile: a removed
        // file stat-fails or parses empty, so refreshFile drops its row and
        // returns null. The index stays correct either way.
        const meta = await this.refreshFile(job.filePath, job.account);
        this.emitter.emit("change", {
          filePath: job.filePath,
          account: job.account,
          meta,
          reason: job.reason,
        } satisfies ScannerChangeEvent);
      } catch (err) {
        this.emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.watcher = new FileWatcher(
      activeProfiles,
      (e) => {
        this.queue?.enqueue({
          filePath: e.filePath,
          account: e.account,
          reason: "watcher",
        });
      },
      { debounceMs: options.debounceMs },
    );
    await this.watcher.start();

    const periodicMs = options.periodicMs ?? 60_000;
    if (periodicMs > 0) {
      this.periodicTimer = setInterval(() => {
        // Track the job so unwatch() can await it — otherwise its post-await
        // engine.files access can land after the DB is closed.
        const job = this.periodicReconcile(activeProfiles).finally(() => {
          if (this.inFlightReconcile === job) this.inFlightReconcile = null;
        });
        this.inFlightReconcile = job;
      }, periodicMs);
      // Don't keep the process alive solely for the rescan timer.
      this.periodicTimer.unref?.();
    }

    getLogger().info({ profiles: activeProfiles.length, periodicMs }, "watch: started");
  }

  // Periodic correctness backstop: re-discover all files and enqueue them
  // through the same queue the watcher uses, so any add/change the watcher
  // missed still gets indexed and emits a "change" event. Vanished files
  // (active in the DB but no longer on disk) are enqueued too — refreshFile
  // drops them. Routing through the queue (not a direct scan) keeps event
  // emission and single-writer serialization unified.
  private async periodicReconcile(activeProfiles: Profile[]): Promise<void> {
    if (!this.queue) return;
    try {
      const engine = this.engine();
      const configDirs = activeProfiles.map((p) => ({
        projectsDir: getProjectsDir(p),
        account: p.id,
      }));
      const discovered = await discoverJsonlFiles(configDirs);
      const seen = new Set<string>();
      for (const { filePath, account } of discovered) {
        seen.add(filePath);
        // Only enqueue genuinely-changed files so an idle tick stays silent
        // (no spurious "change" events for thousands of unchanged files).
        const { change } = classify(filePath, engine.files.getByPath(filePath));
        if (change !== "unchanged") {
          this.queue.enqueue({ filePath, account, reason: "periodic" });
        }
      }
      // Files in the index but gone from disk → enqueue so refreshFile drops them.
      for (const path of engine.files.allActivePaths()) {
        if (!seen.has(path)) {
          this.queue.enqueue({ filePath: path, account: "default", reason: "periodic" });
        }
      }
    } catch (err) {
      this.emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Stop watching and drain any in-flight index jobs.
  async unwatch(): Promise<void> {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
    // Let a reconcile that already started finish touching the DB before we
    // drop the queue/engine below. Its own catch swallows errors; we only wait.
    if (this.inFlightReconcile) {
      await this.inFlightReconcile;
    }
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    if (this.queue) {
      await this.queue.onIdle();
      this.queue = null;
    }
  }

  // ── Provider plumbing (in-memory path) ──────────────────────────────────

  // Build the flat parse worklist for the enabled providers. Threadbase
  // discovers under the active profiles' project dirs; Codex discovers under
  // the explicit codexRoots (opt-in — no default home scan).
  private async discoverWithProviders(
    activeProfiles: Profile[],
    options: ScanOptions,
  ): Promise<{ filePath: string; account: string; provider: ScannerProvider }[]> {
    const enabled = options.providers ?? [CLAUDE_CODE_PROVIDER];
    const work: { filePath: string; account: string; provider: ScannerProvider }[] = [];

    if (enabled.includes(CLAUDE_CODE_PROVIDER)) {
      const provider = new ThreadbaseProvider();
      const roots = activeProfiles.map((p) => `${getProjectsDir(p)}\0${p.id}`);
      for (const f of await provider.discover(roots)) {
        work.push({ ...f, provider });
      }
    }
    if (enabled.includes(CODEX_CLI_PROVIDER) && (options.codexRoots?.length ?? 0) > 0) {
      const provider = new CodexCliProvider();
      for (const f of await provider.discover(options.codexRoots as string[])) {
        work.push({ ...f, provider });
      }
    }
    return work;
  }

  // Resolve which provider should (re)parse a file. Stored metadata wins; for a
  // file the index has not seen, sniff the first lines with each non-Threadbase
  // provider's canParse. Returns undefined for Threadbase (the engine's default
  // tail-read path).
  private async resolveProviderForFile(
    filePath: string,
    previous: ConversationMeta | null,
  ): Promise<ScannerProvider | undefined> {
    if (previous?.provider === CODEX_CLI_PROVIDER) return new CodexCliProvider();
    if (previous?.provider) return undefined; // known Threadbase
    let sample = "";
    try {
      const fd = openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(8192);
        const n = readSync(fd, buf, 0, buf.length, 0);
        sample = buf.subarray(0, n).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
    const codex = new CodexCliProvider();
    if (codex.canParse(filePath, sample)) return codex;
    return undefined;
  }

  private addToSessionIndex(meta: ConversationMeta): void {
    const list = this.sessionIdIndex.get(meta.sessionId);
    if (list) {
      // Replace any existing entry for the same file (re-index), else append.
      const i = list.findIndex((m) => m.id === meta.id);
      if (i >= 0) list[i] = meta;
      else list.push(meta);
    } else {
      this.sessionIdIndex.set(meta.sessionId, [meta]);
    }
  }

  private removeFromSessionIndex(meta: ConversationMeta): void {
    const list = this.sessionIdIndex.get(meta.sessionId);
    if (!list) return;
    const next = list.filter((m) => m.id !== meta.id);
    if (next.length > 0) this.sessionIdIndex.set(meta.sessionId, next);
    else this.sessionIdIndex.delete(meta.sessionId);
  }

  // Deterministic single-result sessionId resolution: newest timestamp first,
  // tie-broken by absolute path ascending.
  private resolveSessionId(sessionId: string): ConversationMeta | undefined {
    return this.sortBySessionPriority(this.sessionIdIndex.get(sessionId) ?? [])[0];
  }

  private sortBySessionPriority(metas: ConversationMeta[]): ConversationMeta[] {
    return [...metas].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
      return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
    });
  }

  private async resolveProfiles(profiles?: Profile[]): Promise<Profile[]> {
    // An explicit array (including an empty one) means "use exactly these" —
    // `[]` scans zero profiles. Only an absent argument falls back to defaults.
    // Treating `[]` as "load defaults" silently scanned the real ~/.claude
    // history, which looked like a hang for callers isolating from it.
    if (profiles) return profiles;
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
