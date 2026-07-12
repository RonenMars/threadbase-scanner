import { statSync } from "fs";
import { readGitBranch } from "../git";
import { getLogger } from "../logger";
import { getProjectsDir } from "../profiles";
import { CodexCliProvider, parseCodexConversation } from "../providers/codex-cli";
import { parseMetaWithProvider } from "../providers/parse";
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_CLI_PROVIDER,
  type ScannerProvider,
} from "../providers/provider";
import { resolveTier } from "../tiers";
import type {
  ConversationMeta,
  ConversationPage,
  GetConversationPageOptions,
  Profile,
  ScanOptions,
} from "../types";
import { classify, type FileChange, fingerprint } from "./cursor";
import { type DB, openDatabase } from "./db";
import { discoverJsonlFilesGated, FULL_RECONCILE_EVERY_N_SCANS } from "./dir-watermark";
import { type TailReadResult, tailReduce } from "./jsonl-tail-reader";
import { finalizeMeta, initialReducerState, type ReducerState } from "./metadata-reducer";
import { buildCheckpoints, CHECKPOINT_INTERVAL, readPage } from "./paged-reader";
import { CheckpointsRepo } from "./repositories/checkpoints.repo";
import { ConversationFilesRepo } from "./repositories/conversation-files.repo";
import { ConversationsRepo } from "./repositories/conversations.repo";
import { FtsRepo } from "./repositories/fts.repo";
import { ScannedDirsRepo } from "./repositories/scanned-dirs.repo";
import { buildSidecar, writeSidecar } from "./sidecar";

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
  readonly checkpoints: CheckpointsRepo;
  readonly scannedDirs: ScannedDirsRepo;
  // When true, write a portable <file>.idx.json sidecar next to each indexed
  // JSONL. Off by default.
  private readonly sidecar: boolean;
  // Counts indexAll() passes so the dir-mtime gate's full-reconcile backstop
  // (FULL_RECONCILE_EVERY_N_SCANS) can fire periodically. In-memory only: a
  // restart just means the first few post-restart scans don't force an early
  // backstop pass, which is harmless (watermarks themselves persist in the DB).
  private scanCount = 0;
  // In-flight checkpoint build/extension per file, so concurrent getPage
  // callers share one stream instead of each walking the file.
  private readonly checkpointBuilds = new Map<string, Promise<void>>();

  constructor(dbPath: string, options: { sidecar?: boolean } = {}) {
    this.db = openDatabase(dbPath);
    this.files = new ConversationFilesRepo(this.db);
    this.conversations = new ConversationsRepo(this.db);
    this.fts = new FtsRepo(this.db);
    this.checkpoints = new CheckpointsRepo(this.db);
    this.scannedDirs = new ScannedDirsRepo(this.db);
    this.sidecar = options.sidecar ?? false;
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

    const enabled = options.providers ?? [CLAUDE_CODE_PROVIDER];

    // Each discovered file carries the provider that should parse it. claude-code
    // files fold through the byte-offset-resumable tail reader; Codex files
    // (opt-in, only under explicit codexRoots) reparse from offset 0.
    const discovered: { filePath: string; account: string; provider?: ScannerProvider }[] = [];

    if (enabled.includes(CLAUDE_CODE_PROVIDER)) {
      const configDirs = activeProfiles.map((p) => ({
        projectsDir: getProjectsDir(p),
        account: p.id,
      }));
      // Escape hatch: an explicit fullRescan bypasses the dir-mtime gate
      // entirely — an explicit refresh is precisely the "don't trust the
      // gate, check for real" signal. Otherwise every FULL_RECONCILE_EVERY_N_SCANS
      // passes also bypasses it, self-healing any add/remove a filesystem that
      // doesn't honor directory mtimes might have hidden from the gate.
      this.scanCount++;
      const forceFullGlob =
        options.fullRescan === true || this.scanCount % FULL_RECONCILE_EVERY_N_SCANS === 0;
      const gated = await discoverJsonlFilesGated(configDirs, this.files, this.scannedDirs, {
        fullRescan: forceFullGlob,
      });
      for (const f of gated) discovered.push(f);
    }

    const codex = new CodexCliProvider();
    if (enabled.includes(CODEX_CLI_PROVIDER) && (options.codexRoots?.length ?? 0) > 0) {
      for (const f of await codex.discover(options.codexRoots as string[])) {
        discovered.push({ ...f, provider: codex });
      }
    }
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
        batch.map(async ({ filePath, account, provider }) => {
          const { meta } = await this.indexFile(
            filePath,
            account,
            tier.name,
            options.tiers,
            resolveGitBranch,
            false,
            provider,
          );
          return meta;
        }),
      );
      const kept = results.filter((m): m is ConversationMeta => m != null);
      if (kept.length > 0) options.onBatch?.(kept);
      scanned += batch.length;
      options.onProgress?.(scanned, discovered.length);
    }

    // Reconcile deletions: any previously-active file that wasn't discovered
    // this pass is gone from disk — mark it deleted. This is the correctness
    // backstop for unlink events the watcher may have missed (spec §9.5).
    //
    // Scope the reconcile to the accounts THIS scan actually covered. The index
    // is shared across profiles/accounts (one index.db), so a scan of account A
    // must not mark account B's files deleted just because B's files weren't in
    // A's discovered set — B is simply out of this scan's scope, not gone from
    // disk. Covered = the claude-code profile ids scanned (when that provider is
    // enabled) plus "codex" (when codex roots were scanned).
    const coveredAccounts = new Set<string>();
    if (enabled.includes(CLAUDE_CODE_PROVIDER)) {
      for (const p of activeProfiles) coveredAccounts.add(p.id);
    }
    if (enabled.includes(CODEX_CLI_PROVIDER) && (options.codexRoots?.length ?? 0) > 0) {
      coveredAccounts.add("codex");
    }
    const seen = new Set(discovered.map((d) => d.filePath));
    for (const path of this.files.activePathsByAccounts([...coveredAccounts])) {
      if (!seen.has(path)) this.markDeleted(path);
    }

    log.info({ scanned, indexed: this.conversations.count() }, "persistent: indexAll complete");
    return { scanned };
  }

  // (Re)index a single file. Classifies the change vs. the persisted cursor:
  // unchanged → return the stored summary; appended → resume the fold and read
  // only new bytes; reindex/force → fold from offset 0. Writes the summary +
  // cursor + reducer state in one transaction so a crash never leaves a
  // half-written row or an over-advanced cursor. Returns the classification
  // alongside the meta so callers (refreshFile) can keep, extend, or evict
  // their own per-file caches without re-stat'ing the file (racy) themselves.
  async indexFile(
    filePath: string,
    account: string,
    tierName: string,
    customTiers: ScanOptions["tiers"],
    resolveGitBranch: (projectPath: string) => string | null,
    force = false,
    provider?: ScannerProvider,
  ): Promise<{ meta: ConversationMeta | null; change: FileChange }> {
    const log = getLogger();
    const tier = resolveTier(tierName, customTiers);

    const existing = this.files.getByPath(filePath);
    const { change, stat } = classify(filePath, existing);

    if (change === "vanished" || !stat) {
      // File gone between discovery and indexing — treat as deleted.
      this.markDeleted(filePath);
      return { meta: null, change: "vanished" };
    }
    // Unchanged: serve the persisted summary without re-reading (unless a
    // caller forces a re-parse, e.g. refreshFile after a same-size edit).
    if (change === "unchanged" && !force) {
      return { meta: this.conversations.getBySourcePath(filePath), change };
    }

    // ponytail: Codex reparses from offset 0 on every change rather than
    // resuming a byte cursor like claude-code. Codex rollout sessions are small,
    // so a full reparse is cheap; the resumable-fold path stays claude-code-only.
    // Upgrade path if Codex files ever get large: give CodexAccumulator the same
    // serialized-reducer-state treatment and route it through tailReduce.
    if (provider && provider.name !== CLAUDE_CODE_PROVIDER) {
      const meta = await this.indexFileWithProvider(
        provider,
        filePath,
        account,
        tier,
        stat,
        resolveGitBranch,
      );
      return { meta, change };
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
      return { meta: null, change };
    }

    const meta = finalizeMeta(state, filePath, account, tier);
    if (!meta) {
      this.markDeleted(filePath);
      return { meta: null, change };
    }
    meta.gitBranch = resolveGitBranch(meta.projectPath);

    const fp = stat.size > 0 ? fingerprint(filePath, stat.size) : null;
    const fileId = this.files.ensure(filePath, account);
    const upsert = this.db.transaction(() => {
      this.conversations.upsert(fileId, meta, state.pageMessageCount);
      this.fts.upsert(meta);
      // Checkpoints cover the file's immutable prefix, so an append (a resumed
      // fold) leaves them valid — drop them only when the fold restarted from
      // offset 0 (truncate/replace/new). They're rebuilt lazily on page access.
      if (!resume) this.checkpoints.remove(filePath);
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

    if (this.sidecar) {
      writeSidecar(
        filePath,
        buildSidecar(
          meta,
          {
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
            offset: result.newOffset,
            line: result.newLine,
          },
          new Date().toISOString(),
        ),
      );
    }

    log.debug(
      { filePath, change, bytesRead: result.newOffset - startOffset, msgs: meta.messageCount },
      "persistent: indexed file",
    );
    return { meta, change };
  }

  // Index a non-Threadbase provider file: full reparse from offset 0 through the
  // provider's reducer/finalize, then the same upsert + FTS write + cursor bump
  // the Threadbase path uses. The cursor records size/mtime (and offset = size)
  // so the next pass classifies an unchanged file as "unchanged" and skips it;
  // any change reparses from 0 again. No reducer_state is persisted.
  private async indexFileWithProvider(
    provider: ScannerProvider,
    filePath: string,
    account: string,
    tier: ReturnType<typeof resolveTier>,
    stat: { size: number; mtimeMs: number },
    resolveGitBranch: (projectPath: string) => string | null,
  ): Promise<ConversationMeta | null> {
    const log = getLogger();

    const meta = await parseMetaWithProvider(provider, filePath, account, tier);
    if (!meta) {
      this.markDeleted(filePath);
      return null;
    }
    // The provider may already know its branch (Codex reads it from
    // session_meta). Only walk the filesystem when it doesn't.
    if (meta.gitBranch === null && meta.projectPath) {
      meta.gitBranch = resolveGitBranch(meta.projectPath);
    }

    const fp = stat.size > 0 ? fingerprint(filePath, stat.size) : null;
    const fileId = this.files.ensure(filePath, account);
    const upsert = this.db.transaction(() => {
      this.conversations.upsert(fileId, meta, meta.messageCount);
      this.fts.upsert(meta);
      this.checkpoints.remove(filePath);
      this.files.updateCursor(fileId, {
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        // offset = size marks the file fully consumed (non-zero so the next pass
        // can classify it "unchanged"); no resumable reducer state is kept.
        offset: stat.size,
        line: 0,
        reducerState: null,
        fingerprint: fp,
        status: "active",
      });
    });
    upsert();

    log.debug(
      { filePath, provider: provider.name, msgs: meta.messageCount },
      "persistent: indexed provider file",
    );
    return meta;
  }

  private markDeleted(filePath: string): void {
    const existing = this.files.getByPath(filePath);
    if (!existing) return;
    const tx = this.db.transaction(() => {
      this.conversations.deleteByFileId(existing.id);
      this.fts.remove(filePath);
      this.checkpoints.remove(filePath);
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

  // Bounded conversation page: read only the requested window from the file,
  // seeking from the nearest checkpoint. Returns null if the id can't be
  // resolved to an indexed conversation. For conversations large enough to span
  // a checkpoint interval, checkpoints are built lazily on first access and
  // reused thereafter. Smaller conversations read from the start (cheap).
  async getPage(id: string, options: GetConversationPageOptions): Promise<ConversationPage | null> {
    const meta = this.conversations.getByIdOrSession(id);
    if (!meta) return null;
    const filePath = meta.filePath;

    // Codex files don't fold through the conversation-reducer the bounded reader
    // (readPage) uses — that reducer only understands the claude-code line shape,
    // so readPage would return an empty window for a Codex file. Codex rollout
    // sessions are small (already reparsed from offset 0 on every change), so
    // parse the whole conversation and slice the window — identical math to the
    // claude-code path and to the legacy getConversationPage slice.
    if (meta.provider === CODEX_CLI_PROVIDER) {
      const conversation = await parseCodexConversation(filePath, meta.account);
      if (!conversation) return null;
      const { messages } = conversation;
      const total = messages.length;
      const beforeIndex = options.beforeIndex ?? total;
      const fromIndex = Math.max(0, beforeIndex - options.limit);
      return { messages: messages.slice(fromIndex, beforeIndex), total, fromIndex };
    }

    // Bounded paging uses the parseConversation message total, which differs
    // from meta.messageCount (the metadata count excludes tool_use-only and
    // thinking-only lines).
    const total = this.conversations.pageMessageCount(filePath);

    await this.ensureCheckpoints(filePath, total);

    const beforeIndex = options.beforeIndex ?? total;
    const fromIndex = Math.max(0, beforeIndex - options.limit);
    let floor = this.checkpoints.floor(filePath, fromIndex);
    // A checkpoint past the current EOF is stale — the file was truncated or
    // replaced on disk and no refresh has landed yet. Seeking there would read
    // nothing (or garbage), so fall back to byte 0: correct, just slower, and
    // the next refresh drops the stale chain. A failed stat is left to
    // readPage, which surfaces the read error exactly as before.
    if (floor) {
      try {
        if (floor.byteOffset > statSync(filePath).size) floor = null;
      } catch {
        // fall through to readPage's own error handling
      }
    }
    return readPage(filePath, total, options, floor);
  }

  // Build or extend the checkpoint chain so it covers `total` messages. Cold
  // file → full build; a file that grew → extend from the last persisted
  // checkpoint (reads only past its offset, never the prefix). Single-flighted
  // per path: concurrent getPage callers await the same build instead of
  // streaming the file in parallel.
  private ensureCheckpoints(filePath: string, total: number): Promise<void> {
    if (total <= CHECKPOINT_INTERVAL) return Promise.resolve();
    const inFlight = this.checkpointBuilds.get(filePath);
    if (inFlight) return inFlight;

    const build = (async () => {
      const last = this.checkpoints.last(filePath);
      // Chain already covers every checkpointable index — nothing to do.
      if (last && total < last.messageIndex + CHECKPOINT_INTERVAL) return;
      const fresh = await buildCheckpoints(filePath, CHECKPOINT_INTERVAL, last);
      if (fresh.length === 0) return;
      if (last) this.checkpoints.append(filePath, fresh);
      else this.checkpoints.replaceAll(filePath, fresh);
    })().finally(() => {
      if (this.checkpointBuilds.get(filePath) === build) this.checkpointBuilds.delete(filePath);
    });
    this.checkpointBuilds.set(filePath, build);
    return build;
  }
}
