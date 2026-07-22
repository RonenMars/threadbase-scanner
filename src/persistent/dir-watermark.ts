import { readdir, stat } from "fs/promises";
import { dirname, join } from "path";
import { canonicalPath } from "../canonical-path";
import { type DiscoveredFile, discoverJsonlFiles } from "../discovery";
import { getLogger } from "../logger";
import type { ConversationFilesRepo } from "./repositories/conversation-files.repo";
import type { ScannedDirsRepo } from "./repositories/scanned-dirs.repo";

// ponytail: full-reconcile backstop runs every Nth gated pass, ignoring all
// watermarks, so a filesystem that doesn't honor directory mtimes (some
// NFS/SMB mounts, a few atomic-replace editors) can't permanently hide a
// missed add/remove. Bump this if that self-heal interval feels too slow for
// a given deployment; there's no config surface for it yet.
export const FULL_RECONCILE_EVERY_N_SCANS = 20;

// Discover JSONL files under each profile's projectsDir, skipping the glob for
// a directory whose file/subdirectory SET hasn't changed since the last pass.
//
// The core invariant (see SCAN-OPTIMIZATION-PROMPT.md Stage 4): the gate only
// ever skips the GLOB (which exists to catch added/removed files — an event
// that bumps the containing directory's mtime). It never skips classify() for
// an already-known file (which exists to catch content changes, e.g. an
// append — an event that does NOT bump the directory's mtime). Every active
// file previously indexed under a project dir is always included in the
// returned list, glob or no glob, so index-engine.ts's deletion-reconcile
// never mistakes a skipped-but-still-known file for a vanished one.
//
// Two-level watermark, matching the real ~/.claude/projects/ shape (one
// project subdirectory per conversation history, sometimes with nested
// subagent/workflow trees below that):
//   - projectsDir itself: catches added/removed PROJECT DIRECTORIES.
//   - each immediate project subdirectory: catches added/removed FILES
//     directly in it. A project dir known to contain nested files (subagents/
//     etc) always re-globs regardless of mtime — a project-dir-level
//     watermark can't see a change two levels down, so it isn't trusted to
//     skip those dirs. This still skips the glob for the common case: most
//     project dirs are flat (session-uuid.jsonl directly inside).
export async function discoverJsonlFilesGated(
  dirs: { projectsDir: string; account: string }[],
  files: ConversationFilesRepo,
  scannedDirs: ScannedDirsRepo,
  options: { fullRescan?: boolean } = {},
): Promise<DiscoveredFile[]> {
  const log = getLogger();
  if (options.fullRescan) {
    return discoverJsonlFiles(dirs);
  }

  const results: DiscoveredFile[] = [];

  for (const rawDir of dirs) {
    const { account } = rawDir;
    // Canonicalize: the reuse branch below compares these dir keys against
    // parent_dir/scanned_dirs.path, which the repositories store canonically.
    // Without this the has_nested/parent_dir lookups silently miss on Windows
    // when a caller's projectsDir came in with the other separator style, and
    // the caller's seen-set then loses those files to the deletion-reconcile.
    const projectsDir = canonicalPath(rawDir.projectsDir);

    const resolved = await resolveProjectDirs(projectsDir, scannedDirs);
    if (resolved === null) continue; // projectsDir unreadable/vanished

    for (const projectDir of resolved.entries) {
      let dirStat: { mtimeMs: number };
      try {
        dirStat = await stat(projectDir);
      } catch {
        // Project dir vanished between listing and stat — drop its watermark;
        // its previously-known files simply won't appear in this pass's
        // result, so index-engine.ts's deletion-reconcile marks them deleted.
        scannedDirs.remove(projectDir);
        continue;
      }

      const watermark = scannedDirs.get(projectDir);
      const canReuse =
        watermark !== undefined &&
        watermark.mtime_ms === dirStat.mtimeMs &&
        watermark.has_nested === 0;

      if (canReuse) {
        const known = files.activePathsByParentDir(projectDir);
        // A watermarked, unchanged dir must have had ≥1 indexed file when it was
        // globbed. Zero known files means the watermark is out of sync with
        // conversation_files — most often a race: another connection sharing this
        // index.db committed the scanned_dirs watermark (during its own discovery)
        // before it finished writing that dir's file rows, and we read in that
        // window. Trusting the empty reuse would drop the dir's conversations from
        // `discovered`, so the caller's deletion-reconcile (or a stale allActive)
        // never surfaces them → 404. Fall through to the glob, which reads the
        // real on-disk truth and re-indexes what's actually there.
        if (known.length > 0) {
          for (const row of known) {
            results.push({ filePath: row.absolute_path, account: row.account });
          }
          continue;
        }
      }

      const found = await discoverJsonlFiles([{ projectsDir: projectDir, account }]);
      const hasNested = found.some((f) => dirnameOf(f.filePath) !== projectDir);
      scannedDirs.upsert(projectDir, projectsDir, dirStat.mtimeMs, hasNested);
      results.push(...found);
    }

    // Commit the root watermark only after every project dir under it has been
    // processed without throwing. Committing it earlier (e.g. right after the
    // readdir) would let a crash mid-loop leave un-globbed project dirs with no
    // scanned_dirs row — the next pass's root-reuse would then return only the
    // dirs that DID get a row, silently dropping the crashed-out dirs' files
    // from `seen` and mass-deleting their conversations.
    if (resolved.commitRoot) {
      scannedDirs.upsert(projectsDir, null, resolved.commitRoot.mtimeMs, false);
      const seen = new Set(resolved.entries);
      for (const known of scannedDirs.childrenOf(projectsDir)) {
        if (!seen.has(known.path)) scannedDirs.remove(known.path);
      }
    }
  }

  log.debug(
    { totalFiles: results.length, dirs: dirs.length },
    "dir-watermark: gated discovery complete",
  );
  return results;
}

interface ResolvedProjectDirs {
  entries: string[];
  // Present only when projectsDir was actually re-listed this pass (root
  // watermark was stale/missing) — the caller commits it after the per-dir
  // loop succeeds. Absent when the root watermark was reused as-is (nothing
  // new to commit).
  commitRoot?: { mtimeMs: number };
}

// The list of immediate project subdirectories under projectsDir, reusing the
// stored list when projectsDir's own mtime hasn't moved (no dirs added or
// removed), otherwise re-listing (but NOT yet persisting — see commitRoot).
// Returns null if projectsDir itself can't be read (e.g. a profile pointing at
// a not-yet-created config dir).
async function resolveProjectDirs(
  projectsDir: string,
  scannedDirs: ScannedDirsRepo,
): Promise<ResolvedProjectDirs | null> {
  let rootStat: { mtimeMs: number };
  try {
    rootStat = await stat(projectsDir);
  } catch {
    return null;
  }

  const rootWatermark = scannedDirs.get(projectsDir);
  if (rootWatermark !== undefined && rootWatermark.mtime_ms === rootStat.mtimeMs) {
    return { entries: scannedDirs.childrenOf(projectsDir).map((row) => row.path) };
  }

  let entries: string[];
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => joinPath(projectsDir, e.name));
  } catch {
    return null;
  }

  return { entries, commitRoot: { mtimeMs: rootStat.mtimeMs } };
}

// Platform-aware: the paths threaded through here are canonical (native
// separator on Windows), so a hardcoded "/" split would read the whole path as
// the dirname and mis-derive has_nested.
function dirnameOf(filePath: string): string {
  return dirname(filePath);
}

function joinPath(dir: string, name: string): string {
  return join(dir, name);
}
