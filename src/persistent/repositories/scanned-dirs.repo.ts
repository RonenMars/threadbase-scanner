import type { Database } from "better-sqlite3";
import { canonicalPath } from "../../canonical-path";

export interface ScannedDirRow {
  path: string;
  parent_root: string | null;
  mtime_ms: number;
  has_nested: number;
}

// Per-directory mtime watermarks backing the discovery dir-mtime gate. One row
// for a profile's projectsDir (parent_root NULL), one row per immediate
// project subdirectory (parent_root = the projectsDir path).
export class ScannedDirsRepo {
  constructor(private db: Database) {}

  get(path: string): ScannedDirRow | undefined {
    return this.db.prepare("SELECT * FROM scanned_dirs WHERE path = ?").get(canonicalPath(path)) as
      | ScannedDirRow
      | undefined;
  }

  // Known project subdirectories under a root, path ascending (stable order).
  childrenOf(parentRoot: string): ScannedDirRow[] {
    return this.db
      .prepare("SELECT * FROM scanned_dirs WHERE parent_root = ? ORDER BY path ASC")
      .all(canonicalPath(parentRoot)) as ScannedDirRow[];
  }

  upsert(path: string, parentRoot: string | null, mtimeMs: number, hasNested: boolean): void {
    this.db
      .prepare(
        `INSERT INTO scanned_dirs (path, parent_root, mtime_ms, has_nested, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(path) DO UPDATE SET
           parent_root = excluded.parent_root,
           mtime_ms = excluded.mtime_ms,
           has_nested = excluded.has_nested,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(
        canonicalPath(path),
        parentRoot === null ? null : canonicalPath(parentRoot),
        mtimeMs,
        hasNested ? 1 : 0,
      );
  }

  // Drop a project subdirectory's watermark row (it vanished from disk).
  remove(path: string): void {
    this.db.prepare("DELETE FROM scanned_dirs WHERE path = ?").run(canonicalPath(path));
  }
}
