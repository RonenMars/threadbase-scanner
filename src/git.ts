import { readFileSync } from "fs";
import { dirname, join } from "path";
import { getLogger } from "./logger";

const REF_PREFIX = "ref: refs/heads/";
const MAX_DEPTH = 6;

export function readGitBranch(projectPath: string): string | null {
  if (!projectPath) return null;
  const log = getLogger();

  let dir = projectPath;
  let depth = 0;

  while (depth < MAX_DEPTH) {
    const headPath = join(dir, ".git", "HEAD");
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
