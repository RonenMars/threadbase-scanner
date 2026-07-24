import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createLogger } from "./lib/log.mjs";
import { fixturesDirFromScript, isMainModule } from "./lib/module.mjs";

const log = createLogger("validate-live");
const DEFAULT_FIXTURES_DIR = fixturesDirFromScript(import.meta.url);

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

type LogFn = (...args: unknown[]) => void;

/** Compare two baselines. Returns process exit code (0 ok / non-breaking, 1 breaking). */
export function validateLiveBaselines(
  fixturesDir: string = DEFAULT_FIXTURES_DIR,
  emit: LogFn = (...args) => log.info(args.map(String).join(" ")),
): number {
  const baseline = join(fixturesDir, "baseline-live.jsonl");
  const prevBaseline = join(fixturesDir, "baseline-live.prev.jsonl");

  log.step("init", `fixtures=${fixturesDir}`);

  if (!existsSync(baseline)) {
    log.step("check-baseline", "missing");
    emit("No baseline found. Run 'npm run capture-live' first.");
    log.step("done", "ok");
    return 0;
  }
  log.step("check-baseline", "ok");

  log.step("extract-current");
  const current = extractFieldTypes(baseline);
  log.step("extract-current", `paths=${current.size}`);

  if (!existsSync(prevBaseline)) {
    log.step("check-prev", "missing");
    emit(
      "No previous baseline to compare against. Current baseline has",
      current.size,
      "field paths.",
    );
    emit(
      "Run 'npm run update-baseline' to establish the baseline, then run again after a new capture.",
    );
    log.step("done", "ok");
    return 0;
  }
  log.step("check-prev", "ok");

  log.step("extract-prev");
  const prev = extractFieldTypes(prevBaseline);
  log.step("compare");
  const { added, removed, typeChanged } = compare(prev, current);

  if (added.length === 0 && removed.length === 0 && typeChanged.length === 0) {
    emit("No format drift detected. JSONL structure matches previous baseline.");
    log.step("done", "ok no-drift");
    return 0;
  }

  emit("FORMAT DRIFT DETECTED:\n");
  if (removed.length > 0) {
    emit("REMOVED FIELDS (breaking):");
    removed.forEach((r) => emit(`  ${r}`));
  }
  if (typeChanged.length > 0) {
    emit("\nTYPE CHANGES:");
    typeChanged.forEach((t) => emit(`  ${t}`));
  }
  if (added.length > 0) {
    emit("\nNEW FIELDS (non-breaking):");
    added.forEach((a) => emit(`  ${a}`));
  }

  if (removed.length > 0 || typeChanged.length > 0) {
    log.fail(
      "compare",
      `breaking drift removed=${removed.length} typeChanged=${typeChanged.length} added=${added.length}`,
    );
    log.step("done", "fail");
    return 1;
  }
  log.step("done", "ok additive-only");
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(validateLiveBaselines());
}
