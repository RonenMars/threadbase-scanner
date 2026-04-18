import fg from "fast-glob";
import { stat } from "fs/promises";

export interface DiscoveredFile {
  filePath: string;
  account: string;
}

const EXCLUDED_SEGMENTS = ["/memory/", "/tool-results/"];

export async function discoverJsonlFiles(
  dirs: { projectsDir: string; account: string }[],
  onProgress?: (found: number) => void,
): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = [];

  for (const { projectsDir, account } of dirs) {
    let filePaths: string[];
    try {
      filePaths = await fg("**/*.jsonl", {
        cwd: projectsDir,
        absolute: true,
        dot: false,
      });
    } catch {
      continue;
    }

    // Filter out excluded directory segments
    const filtered = filePaths.filter((fp) => !EXCLUDED_SEGMENTS.some((seg) => fp.includes(seg)));

    // Filter out empty files
    for (const filePath of filtered) {
      try {
        const s = await stat(filePath);
        if (s.size > 0) {
          results.push({ filePath, account });
        }
      } catch {
        // Skip inaccessible files
      }
    }

    onProgress?.(results.length);
  }

  return results;
}
