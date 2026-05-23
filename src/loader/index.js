// ESM loader for @ronenmars/threadbase-scanner.
//
// Bytenode .jsc files are CommonJS. This loader bridges CJS → ESM by:
//   1. Resolving the .jsc for the current Node major
//   2. Loading it via createRequire
//   3. Re-exporting its named exports for ESM consumers
//
// MAINTENANCE: when scanner's src/index.ts adds or removes a runtime export,
// update the destructured list below. Types-only exports do NOT need to be
// listed here — they live in dist/index.d.ts and aren't part of the runtime
// module shape. The CJS loader (index.cjs) has no equivalent maintenance need
// because it forwards module.exports directly.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const major = Number.parseInt(process.versions.node.split(".")[0], 10);
const jscPath = join(__dirname, `node-${major}`, "index.jsc");

if (!existsSync(jscPath)) {
  const available = readdirSync(__dirname)
    .filter((d) => /^node-\d+$/.test(d))
    .map((d) => d.slice(5))
    .sort((a, b) => Number(a) - Number(b))
    .join(", ");
  throw new Error(
    `@ronenmars/threadbase-scanner does not support Node ${process.versions.node}. ` +
      `Supported majors: ${available || "(none found — broken install)"}.`,
  );
}

require("bytenode");
const mod = require(jscPath);

export default mod;
export const {
  // Classes
  ConversationScanner,
  SearchIndexer,
  // Filter functions
  applyAccountFilter,
  applyIncludeFilter,
  applyPagination,
  applyProjectFilter,
  applySinceFilter,
  applySort,
  // Tag helpers
  cleanSystemTags,
  // Logger
  createLogger,
  getLogger,
  setLogger,
  // Profiles
  detectDefaultProfile,
  getProjectsDir,
  loadProfiles,
  resolveConfigDir,
  saveProfiles,
  // Git
  readGitBranch,
  // Convenience functions
  scan,
  search,
  getConversation,
  resetDefaultScanner,
  // Tiers
  DEFAULT_TIERS,
  resolveTier,
  // Constants from types
  VALID_SORT_ORDERS,
} = mod;
