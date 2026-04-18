import { readFileSync } from "fs";
import { dirname, join } from "path";

const REF_PREFIX = "ref: refs/heads/";
const MAX_DEPTH = 6;

export function readGitBranch(projectPath: string): string | null {
  if (!projectPath) return null;

  let dir = projectPath;
  let depth = 0;

  while (depth < MAX_DEPTH) {
    const headPath = join(dir, ".git", "HEAD");
    try {
      const content = readFileSync(headPath, "utf-8").trim();
      if (content.startsWith(REF_PREFIX)) {
        return content.slice(REF_PREFIX.length);
      }
      // Detached HEAD: raw commit SHA
      if (content.length >= 7) {
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

  return null;
}
