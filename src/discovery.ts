import fg from "fast-glob";
import { stat } from "fs/promises";
import { getLogger } from "./logger";

export interface DiscoveredFile {
  filePath: string;
  account: string;
}

const EXCLUDED_SEGMENTS = ["/memory/", "/tool-results/"];

// stat() is cheap and IO-bound, so a large history scans much faster when the
// calls run concurrently rather than one-at-a-time. Cap concurrency well under
// typical fd limits.
const STAT_CONCURRENCY = 32;

export async function discoverJsonlFiles(
  dirs: { projectsDir: string; account: string }[],
  onProgress?: (found: number) => void,
): Promise<DiscoveredFile[]> {
  const log = getLogger();
  const results: DiscoveredFile[] = [];

  for (const { projectsDir, account } of dirs) {
    let filePaths: string[];
    try {
      filePaths = await fg("**/*.jsonl", {
        cwd: projectsDir,
        absolute: true,
        dot: false,
      });
    } catch (err) {
      log.warn({ projectsDir, account, err }, "discovery: glob failed");
      continue;
    }

    // Filter out excluded directory segments
    const filtered = filePaths.filter((fp) => !EXCLUDED_SEGMENTS.some((seg) => fp.includes(seg)));

    // Filter out empty files. Stat concurrently in bounded chunks; chunk order
    // is preserved and intra-chunk order follows the input, so discovery order
    // is stable (downstream sorts anyway).
    let kept = 0;
    let skippedEmpty = 0;
    let skippedInaccessible = 0;
    for (let i = 0; i < filtered.length; i += STAT_CONCURRENCY) {
      const chunk = filtered.slice(i, i + STAT_CONCURRENCY);
      const statted = await Promise.all(
        chunk.map(async (filePath) => {
          try {
            const s = await stat(filePath);
            return { filePath, size: s.size };
          } catch (err) {
            log.warn({ filePath, err }, "discovery: stat failed");
            return { filePath, size: -1 };
          }
        }),
      );
      for (const { filePath, size } of statted) {
        if (size < 0) {
          skippedInaccessible++;
        } else if (size > 0) {
          results.push({ filePath, account });
          kept++;
        } else {
          skippedEmpty++;
        }
      }
    }

    log.debug(
      {
        projectsDir,
        account,
        globMatches: filePaths.length,
        afterExclusions: filtered.length,
        kept,
        skippedEmpty,
        skippedInaccessible,
      },
      "discovery: directory scanned",
    );

    onProgress?.(results.length);
  }

  log.debug({ totalFiles: results.length, dirs: dirs.length }, "discovery: complete");
  return results;
}
