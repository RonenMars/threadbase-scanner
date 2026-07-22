import { sep } from "path";

// Canonical absolute-path form used as the identity key for a conversation file
// across the whole index (SQLite rows, the in-memory metadata cache, the
// dir-mtime watermarks, and every by-path lookup).
//
// The problem this solves: fast-glob (discovery) emits forward-slash paths even
// on Windows, while the file watcher (chokidar), path.join(), and every caller
// that builds a path with the platform API emit native (back)slashes. The same
// real file could therefore be stored/looked-up under two different string keys
// on Windows, so by-path APIs miss rows depending on the caller's separator
// style. Normalizing collapses both forms onto one key.
//
// The native separator is the canonical form, not fast-glob's forward slashes:
// a path handed back to a caller (ConversationMeta.filePath/id, a change event,
// a metadata-cache key) is compared against platform-built paths by every
// consumer, so the native spelling is the one the public surface has to speak.
// The cost is a one-time reindex for an index.db written before this change
// (its forward-slash rows miss, get reinserted in native form, and the same
// pass's deletion-reconcile retires the old ones) — bounded and self-healing,
// unlike the recurrent duplicate-row churn this fixes.
//
// On POSIX this is a no-op: the separator is already "/", and a backslash is a
// legal filename character there, so it must be left untouched.
export function canonicalPath(p: string): string {
  return sep === "\\" ? p.replace(/\//g, "\\") : p;
}
