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

  // Grew past the cursor. Usually a genuine append — but an atomic replace with
  // a DIFFERENT, LONGER file also lands here (size > offset, mtime moved). If we
  // trusted "appended" blindly we'd resume the OLD reducer state and fold only
  // the new tail, blending two conversations. So re-check the region we already
  // folded before taking the fast path.
  //
  // The stored content_fingerprint was computed as fingerprint(_, size_bytes)
  // over the old file. It describes the same byte range as fingerprint(current,
  // last_indexed_offset) ONLY when size_bytes === last_indexed_offset (no
  // trailing partial line was pending at index time — the normal case). When
  // that holds and the fingerprints match, we treat it as a real append and
  // resume the cursor; a mismatch means the indexed region changed → reindex.
  // When it doesn't hold (a partial line was pending), we can't reconstruct the
  // stored window, so we reindex to be safe.
  //
  // ponytail: fingerprint() only covers the first 4KB + the 4KB ending at the
  // offset — NOT the whole [0, offset) prefix. So this catches every real atomic
  // replace (any rewrite changes line 1 → different head 4KB) but NOT a rewrite
  // that keeps both 8KB windows byte-identical and differs only in the middle.
  // That's the same bounded ceiling the existing same-size edge-fingerprint has,
  // accepted by design. Upgrade to a full-prefix hash (or an offset-keyed head
  // fingerprint column) only if a mid-file-preserving-envelope rewrite is ever
  // observed in practice — and that same column would also let the pending-
  // partial-then-grew case resume instead of reindexing.
  if (
    existing.content_fingerprint &&
    existing.size_bytes === existing.last_indexed_offset &&
    fingerprint(filePath, existing.last_indexed_offset) === existing.content_fingerprint
  ) {
    return { change: "appended", stat };
  }
  return { change: "reindex", stat };
}
