import { readFileSync, existsSync } from "fs";
import { join } from "path";

const FIXTURES_DIR = join(__dirname, "../__fixtures__");
const BASELINE = join(FIXTURES_DIR, "baseline-live.jsonl");
const PREV_BASELINE = join(FIXTURES_DIR, "baseline-live.prev.jsonl");

function extractFieldTypes(jsonlPath: string): Map<string, Set<string>> {
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

function walkObject(obj: unknown, prefix: string, result: Map<string, Set<string>>) {
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

function compare(prev: Map<string, Set<string>>, curr: Map<string, Set<string>>) {
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

// ─── Main ─────────────────────────────────────────────────────────

if (!existsSync(BASELINE)) {
  console.log("No baseline found. Run 'npm run capture-live' first.");
  process.exit(0);
}

const current = extractFieldTypes(BASELINE);

if (!existsSync(PREV_BASELINE)) {
  console.log("No previous baseline to compare against. Current baseline has", current.size, "field paths.");
  console.log("Run 'npm run update-baseline' to establish the baseline, then run again after a new capture.");
  process.exit(0);
}

const prev = extractFieldTypes(PREV_BASELINE);
const { added, removed, typeChanged } = compare(prev, current);

if (added.length === 0 && removed.length === 0 && typeChanged.length === 0) {
  console.log("No format drift detected. JSONL structure matches previous baseline.");
  process.exit(0);
}

console.log("FORMAT DRIFT DETECTED:\n");
if (removed.length > 0) {
  console.log("REMOVED FIELDS (breaking):");
  removed.forEach((r) => console.log(`  ${r}`));
}
if (typeChanged.length > 0) {
  console.log("\nTYPE CHANGES:");
  typeChanged.forEach((t) => console.log(`  ${t}`));
}
if (added.length > 0) {
  console.log("\nNEW FIELDS (non-breaking):");
  added.forEach((a) => console.log(`  ${a}`));
}

// Exit 1 if there are breaking changes (removed fields or type changes)
if (removed.length > 0 || typeChanged.length > 0) {
  process.exit(1);
}
