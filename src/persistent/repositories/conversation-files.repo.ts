import type { Database } from "better-sqlite3";
import { basename, dirname } from "path";

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
      .get(absolutePath) as FileRow | undefined;
  }

  // Insert a freshly-discovered file at offset 0; returns its row id. Existing
  // path is left untouched (returns the existing id) so a re-discovery is safe.
  ensure(absolutePath: string, account: string): number {
    const existing = this.getByPath(absolutePath);
    if (existing) return existing.id;

    const info = this.db
      .prepare(
        `INSERT INTO conversation_files (absolute_path, parent_dir, file_name, account)
         VALUES (?, ?, ?, ?)`,
      )
      .run(absolutePath, dirname(absolutePath), basename(absolutePath), account);
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
}
