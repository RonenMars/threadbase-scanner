import type { Database } from "better-sqlite3";
import { basename, dirname } from "path";
import { canonicalPath } from "../../canonical-path";

// One tracked JSONL source file + its incremental indexing cursor.
export interface FileRow {
  id: number;
  absolute_path: string;
  parent_dir: string;
  file_name: string;
  account: string;
  size_bytes: number;
  mtime_ms: number;
  last_indexed_offset: number;
  last_indexed_line: number;
  reducer_state: string | null;
  content_fingerprint: string | null;
  status: string;
  last_indexed_at: string | null;
}

export class ConversationFilesRepo {
  constructor(private db: Database) {}

  getByPath(absolutePath: string): FileRow | undefined {
    return this.db
      .prepare("SELECT * FROM conversation_files WHERE absolute_path = ?")
      .get(canonicalPath(absolutePath)) as FileRow | undefined;
  }

  // Insert a freshly-discovered file at offset 0; returns its row id. Existing
  // path is left untouched (returns the existing id) so a re-discovery is safe.
  //
  // absolute_path/parent_dir are stored canonicalized so a caller that built the
  // path with the native separator (watcher, path.join) and one that got it from
  // fast-glob (forward slashes, even on Windows) land on the same row instead of
  // inserting a duplicate.
  ensure(absolutePath: string, account: string): number {
    const canonical = canonicalPath(absolutePath);
    const existing = this.getByPath(canonical);
    if (existing) return existing.id;

    const info = this.db
      .prepare(
        `INSERT INTO conversation_files (absolute_path, parent_dir, file_name, account)
         VALUES (?, ?, ?, ?)`,
      )
      .run(canonical, dirname(canonical), basename(canonical), account);
    return Number(info.lastInsertRowid);
  }

  // Advance the cursor + persisted reducer state after a successful index pass.
  updateCursor(
    id: number,
    fields: {
      sizeBytes: number;
      mtimeMs: number;
      offset: number;
      line: number;
      reducerState: string | null;
      fingerprint: string | null;
      status?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE conversation_files
         SET size_bytes = ?, mtime_ms = ?, last_indexed_offset = ?, last_indexed_line = ?,
             reducer_state = ?, content_fingerprint = ?, status = ?,
             last_indexed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(
        fields.sizeBytes,
        fields.mtimeMs,
        fields.offset,
        fields.line,
        fields.reducerState,
        fields.fingerprint,
        fields.status ?? "active",
        id,
      );
  }

  // Reset the cursor to 0 for a truncated/replaced file before a full reindex.
  resetCursor(id: number): void {
    this.db
      .prepare(
        `UPDATE conversation_files
         SET last_indexed_offset = 0, last_indexed_line = 0, reducer_state = NULL,
             status = 'needs_reindex', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(id);
  }

  setStatus(id: number, status: string): void {
    const deletedAt = status === "deleted" ? "CURRENT_TIMESTAMP" : "deleted_at";
    this.db
      .prepare(
        `UPDATE conversation_files
         SET status = ?, deleted_at = ${deletedAt}, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(status, id);
  }

  allActivePaths(): string[] {
    const rows = this.db
      .prepare("SELECT absolute_path FROM conversation_files WHERE status != 'deleted'")
      .all() as { absolute_path: string }[];
    return rows.map((r) => r.absolute_path);
  }

  // Active file paths belonging to any of the given accounts. Backs the
  // deletion-reconcile so a scan that covered only some accounts can't mark
  // another account's files deleted (they live in the same shared index.db but
  // a different profile owns them). Returns [] for an empty account list.
  activePathsByAccounts(accounts: string[]): string[] {
    if (accounts.length === 0) return [];
    const placeholders = accounts.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT absolute_path FROM conversation_files
         WHERE status != 'deleted' AND account IN (${placeholders})`,
      )
      .all(...accounts) as { absolute_path: string }[];
    return rows.map((r) => r.absolute_path);
  }

  // Active files whose immediate parent is exactly parentDir (no nested
  // subdirectories). Backs the dir-mtime gate's reuse path: a project dir with
  // an unchanged mtime and no nested files can skip the glob entirely.
  activePathsByParentDir(parentDir: string): { absolute_path: string; account: string }[] {
    return this.db
      .prepare(
        "SELECT absolute_path, account FROM conversation_files WHERE parent_dir = ? AND status != 'deleted'",
      )
      .all(canonicalPath(parentDir)) as { absolute_path: string; account: string }[];
  }
}
