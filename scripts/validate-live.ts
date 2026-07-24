import { readFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_DIR = join(HERE, "../__fixtures__");

export function extractFieldTypes(jsonlPath: string): Map<string, Set<string>> {
  const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
  const fieldTypes = new Map<string, Set<string>>();

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      walkObject(obj, "", fieldTypes);
    } catch {
      // Skip malformed lines
    }
  }
  return fieldTypes;
}

export function walkObject(obj: unknown, prefix: string, result: Map<string, Set<string>>) {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== "object") return;

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

    if (!result.has(path)) result.set(path, new Set());
    result.get(path)!.add(type);

    if (type === "object") walkObject(value, path, result);
    if (type === "array" && Array.isArray(value) && value.length > 0) {
      walkObject(value[0], `${path}[]`, result);
    }
  }
}

export function compare(prev: Map<string, Set<string>>, curr: Map<string, Set<string>>) {
  const added: string[] = [];
  const removed: string[] = [];
  const typeChanged: string[] = [];

  for (const [path, types] of curr) {
    if (!prev.has(path)) {
      added.push(`+ ${path}: ${[...types].join("|")}`);
    } else {
      const prevTypes = prev.get(path)!;
      const currStr = [...types].sort().join("|");
      const prevStr = [...prevTypes].sort().join("|");
      if (currStr !== prevStr) {
        typeChanged.push(`~ ${path}: ${prevStr} → ${currStr}`);
      }
    }
  }

  for (const path of prev.keys()) {
    if (!curr.has(path)) {
      removed.push(`- ${path}: ${[...prev.get(path)!].join("|")}`);
    }
  }

  return { added, removed, typeChanged };
}

/** Compare two baselines. Returns process exit code (0 ok / non-breaking, 1 breaking). */
export function validateLiveBaselines(
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
  log: (...args: unknown[]) => void = console.log,
): number {
  const baseline = join(fixturesDir, "baseline-live.jsonl");
  const prevBaseline = join(fixturesDir, "baseline-live.prev.jsonl");

  if (!existsSync(baseline)) {
    log("No baseline found. Run 'npm run capture-live' first.");
    return 0;
  }

  const current = extractFieldTypes(baseline);

  if (!existsSync(prevBaseline)) {
    log(
      "No previous baseline to compare against. Current baseline has",
      current.size,
      "field paths.",
    );
    log(
      "Run 'npm run update-baseline' to establish the baseline, then run again after a new capture.",
    );
    return 0;
  }

  const prev = extractFieldTypes(prevBaseline);
  const { added, removed, typeChanged } = compare(prev, current);

  if (added.length === 0 && removed.length === 0 && typeChanged.length === 0) {
    log("No format drift detected. JSONL structure matches previous baseline.");
    return 0;
  }

  log("FORMAT DRIFT DETECTED:\n");
  if (removed.length > 0) {
    log("REMOVED FIELDS (breaking):");
    removed.forEach((r) => log(`  ${r}`));
  }
  if (typeChanged.length > 0) {
    log("\nTYPE CHANGES:");
    typeChanged.forEach((t) => log(`  ${t}`));
  }
  if (added.length > 0) {
    log("\nNEW FIELDS (non-breaking):");
    added.forEach((a) => log(`  ${a}`));
  }

  if (removed.length > 0 || typeChanged.length > 0) {
    return 1;
  }
  return 0;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  process.exit(validateLiveBaselines());
}
