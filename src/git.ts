import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { getLogger } from "./logger";

const REF_PREFIX = "ref: refs/heads/";
const MAX_DEPTH = 6;

// Where HEAD lives for the checkout at `dir`. In a linked worktree `.git` is a
// file pointing at <root>/.git/worktrees/<name>, and that directory holds HEAD.
function headFile(dir: string): string {
  const dotGit = join(dir, ".git");
  try {
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"))?.[1];
    if (gitdir) return join(resolve(dir, gitdir), "HEAD");
  } catch {
    // .git is a directory (EISDIR) or absent: fall through to the plain layout
  }
  return join(dotGit, "HEAD");
}

export function readGitBranch(projectPath: string): string | null {
  if (!projectPath) return null;
  const log = getLogger();

  let dir = projectPath;
  let depth = 0;

  while (depth < MAX_DEPTH) {
    const headPath = headFile(dir);
    try {
      const content = readFileSync(headPath, "utf-8").trim();
      if (content.startsWith(REF_PREFIX)) {
        const branch = content.slice(REF_PREFIX.length);
        log.trace({ projectPath, dir, branch }, "git: branch resolved");
        return branch;
      }
      // Detached HEAD: raw commit SHA
      if (content.length >= 7) {
        log.trace({ projectPath, dir }, "git: detached HEAD");
        return "(detached)";
      }
      return null;
    } catch {
      // .git/HEAD not found at this level
    }

    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
    depth++;
  }

  log.trace({ projectPath }, "git: no .git found within depth");
  return null;
}

export interface ProjectRoot {
  /** The main checkout: where `.git` is a directory. Equals the path itself when it is not a linked worktree. */
  projectRoot: string;
  /** The path itself when it is a linked worktree of `projectRoot`; null otherwise. */
  worktreePath: string | null;
}

// A linked worktree's `.git` file reads `gitdir: <root>/.git/worktrees/<name>`.
// A submodule's reads `gitdir: <root>/.git/modules/<name>` and is its own project.
const WORKTREE_GITDIR = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/;

/**
 * Which project a working directory belongs to, so a repo and its linked
 * worktrees can be grouped. Reads one small file, no `git` subprocess, and
 * looks at the exact directory only (no walk up, unlike readGitBranch).
 *
 * Returns null when nothing can be said (path gone, no `.git`), so a caller
 * leaves its fields unset and retries on a later scan. A deleted worktree
 * resolves to nothing; that is accepted.
 */
export function readProjectRoot(projectPath: string): ProjectRoot | null {
  if (!projectPath) return null;
  const path = resolve(projectPath);

  let text: string;
  try {
    text = readFileSync(join(path, ".git"), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EISDIR") return null;
    return { projectRoot: path, worktreePath: null };
  }

  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  const root = gitdir ? WORKTREE_GITDIR.exec(resolve(path, gitdir))?.[1] : undefined;
  return root
    ? { projectRoot: root, worktreePath: path }
    : { projectRoot: path, worktreePath: null };
}

// Per-scan memo: a scan has thousands of conversations but few distinct
// project paths. Never longer-lived: a worktree can be added or removed between
// scans.
export function memoByPath<T>(fn: (projectPath: string) => T): (projectPath: string) => T {
  const memo = new Map<string, T>();
  return (projectPath) => {
    if (!memo.has(projectPath)) memo.set(projectPath, fn(projectPath));
    return memo.get(projectPath) as T;
  };
}
