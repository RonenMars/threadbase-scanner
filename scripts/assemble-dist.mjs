#!/usr/bin/env node
// Runs in the CI release workflow's `publish` job, after each matrix entry has
// uploaded its per-Node dist/ as an artifact and the publish job has downloaded
// them all with `actions/download-artifact` (merge-multiple: true) into dist/.
//
// At entry, dist/ looks like:
//   dist/
//   ├── index.cjs            # loader (same in every artifact — last write wins, fine)
//   ├── index.js             # loader (ditto)
//   ├── cli.cjs              # loader (ditto)
//   ├── index.d.ts           # types (from one matrix entry — same everywhere)
//   ├── index.d.cts          # types (ditto)
//   ├── node-22/{index,cli}.jsc
//   ├── node-23/{index,cli}.jsc
//   ├── node-24/{index,cli}.jsc
//   ├── node-25/{index,cli}.jsc
//   └── node-26/{index,cli}.jsc
//
// This script's only jobs are: validate that all expected Node majors are present,
// write dist/supported-nodes.json, and fail loudly if anything is missing so
// `npm publish` doesn't ship a half-baked package.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const distDir = join(repoRoot, "dist");

// Keep in sync with .github/workflows/release.yml matrix.
const EXPECTED_MAJORS = [22, 23, 24, 25, 26];

const failures = [];

// Verify each expected node-<major>/ directory has both .jsc files.
for (const major of EXPECTED_MAJORS) {
  const nodeDir = join(distDir, `node-${major}`);
  if (!existsSync(nodeDir)) {
    failures.push(`missing dist/node-${major}/ — matrix job for Node ${major} did not run or failed`);
    continue;
  }
  for (const f of ["index.jsc", "cli.jsc"]) {
    if (!existsSync(join(nodeDir, f))) {
      failures.push(`missing dist/node-${major}/${f}`);
    }
  }
}

// Verify loader files are in place.
for (const f of ["index.cjs", "index.js", "cli.cjs"]) {
  if (!existsSync(join(distDir, f))) {
    failures.push(`missing dist/${f} (loader) — build-bytenode.mjs did not run`);
  }
}

// Verify types are in place.
for (const f of ["index.d.ts", "index.d.cts"]) {
  if (!existsSync(join(distDir, f))) {
    failures.push(`missing dist/${f} (types) — tsup dts emission did not run`);
  }
}

// Verify nothing leaked: no bundled source JS outside the loaders.
// (The loaders are short, hand-written, and intentionally plain text.)
const ALLOWED_TOP_LEVEL_JS = new Set(["index.cjs", "index.js", "cli.cjs"]);
for (const entry of readdirSync(distDir, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|cjs|mjs)$/.test(entry.name) && !ALLOWED_TOP_LEVEL_JS.has(entry.name)) {
    failures.push(`unexpected JS file in dist/: ${entry.name} (bundled source must not ship)`);
  }
}

if (failures.length > 0) {
  console.error("[assemble-dist] FAIL");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// Write dist/supported-nodes.json — a small machine-readable manifest the
// loader doesn't need (it discovers majors via readdirSync) but tests and
// downstream tools can read.
const manifest = { majors: EXPECTED_MAJORS };
writeFileSync(join(distDir, "supported-nodes.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[assemble-dist] OK — dist/ ready for publish with .jsc for Node ${EXPECTED_MAJORS.join(", ")}`,
);
