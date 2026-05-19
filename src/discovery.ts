import fg from "fast-glob";
import { stat } from "fs/promises";
import { getLogger } from "./logger";

export interface DiscoveredFile {
  filePath: string;
  account: string;
}

const EXCLUDED_SEGMENTS = ["/memory/", "/tool-results/"];

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

    // Filter out empty files
    let kept = 0;
    let skippedEmpty = 0;
    let skippedInaccessible = 0;
    for (const filePath of filtered) {
      try {
        const s = await stat(filePath);
        if (s.size > 0) {
          results.push({ filePath, account });
          kept++;
        } else {
          skippedEmpty++;
        }
      } catch (err) {
        skippedInaccessible++;
        log.warn({ filePath, err }, "discovery: stat failed");
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
