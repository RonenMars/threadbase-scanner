import { createHash } from "crypto";
import { closeSync, openSync, readSync, statSync } from "fs";
import type { FileRow } from "./repositories/conversation-files.repo";

export type FileChange = "unchanged" | "appended" | "reindex" | "vanished";

export interface FileStat {
  size: number;
  mtimeMs: number;
}

// Cheap content fingerprint: hash of the first + last 4KB plus the size. Lets
// us detect a same-size in-place rewrite (e.g. a file replaced atomically)
// without hashing an entire 200MB file. (Spec §9.4.)
const FP_BYTES = 4096;

export function fingerprint(filePath: string, size: number): string {
  const hash = createHash("sha1");
  hash.update(String(size));
  const fd = openSync(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(FP_BYTES, size));
    if (head.length > 0) {
      readSync(fd, head, 0, head.length, 0);
      hash.update(head);
    }
    if (size > FP_BYTES) {
      const tailLen = Math.min(FP_BYTES, size);
      const tail = Buffer.alloc(tailLen);
      readSync(fd, tail, 0, tailLen, size - tailLen);
      hash.update(tail);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// Classify how a file changed relative to its persisted cursor row. Drives
// whether the indexer skips, tail-reads from the cursor, or reindexes from 0.
// (Spec §9.)
export function classify(
  filePath: string,
  existing: FileRow | undefined,
): { change: FileChange; stat?: FileStat } {
  let stat: FileStat;
  try {
    const s = statSync(filePath);
    stat = { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return { change: "vanished" };
  }

  if (!existing || existing.status !== "active" || existing.last_indexed_offset === 0) {
    return { change: "reindex", stat };
  }

  // Smaller than where we left off → truncated/replaced. Reindex.
  if (stat.size < existing.last_indexed_offset) {
    return { change: "reindex", stat };
  }

  // Same size + same mtime → nothing to do.
  if (stat.size === existing.size_bytes && stat.mtimeMs === existing.mtime_ms) {
    return { change: "unchanged", stat };
  }

  // Same size but mtime moved → possible in-place rewrite. Fingerprint to be
  // sure; a changed fingerprint means the bytes we already indexed are stale.
  if (stat.size === existing.last_indexed_offset) {
    const fp = fingerprint(filePath, stat.size);
    if (existing.content_fingerprint && fp !== existing.content_fingerprint) {
      return { change: "reindex", stat };
    }
    return { change: "unchanged", stat };
  }

  // Grew past the cursor → append-only fast path.
  return { change: "appended", stat };
}
