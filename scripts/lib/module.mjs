import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute directory containing the caller module. */
export function scriptDir(importMetaUrl) {
  return dirname(fileURLToPath(importMetaUrl));
}

/**
 * Repo root for a module under scripts/ or scripts/lib/.
 * Pass the caller's import.meta.url (not this helper's).
 */
export function repoRootFromScript(importMetaUrl) {
  const dir = scriptDir(importMetaUrl);
  if (/[/\\]lib$/.test(dir)) return resolve(dir, "../..");
  return resolve(dir, "..");
}

export function fixturesDirFromScript(importMetaUrl) {
  return join(repoRootFromScript(importMetaUrl), "__fixtures__");
}

export function baselinePaths(importMetaUrl) {
  const fixturesDir = fixturesDirFromScript(importMetaUrl);
  return {
    fixturesDir,
    baselineLive: join(fixturesDir, "baseline-live.jsonl"),
    baselinePrev: join(fixturesDir, "baseline-live.prev.jsonl"),
  };
}

/** True when this module was executed directly (not imported). */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (!entry || !existsSync(entry)) return false;
  try {
    return fileURLToPath(importMetaUrl) === entry;
  } catch {
    return false;
  }
}
