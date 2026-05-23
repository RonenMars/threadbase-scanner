#!/usr/bin/env node
// Compile tsup output (dist/index.cjs, dist/cli.js) to V8 bytecode (.jsc) for
// the Node major currently running this script. Output lands in:
//   dist/node-<major>/index.jsc
//   dist/node-<major>/cli.jsc
//
// Then replace the plain-JS loader inputs in dist/ with the small dispatching
// loader files from src/loader/, so a local single-Node build produces a
// working dist/ that can be required immediately.
//
// In CI the multi-Node matrix uploads each per-Node dist/ as an artifact and
// `scripts/assemble-dist.mjs` merges them before publish. Locally, only the
// current Node major's .jsc exists — that's fine for `npm test`-style checks
// against the loader on the developer machine.

import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const repoRoot = resolve(__dirname, "..");
const distDir = join(repoRoot, "dist");
const loaderDir = join(repoRoot, "src", "loader");

// Use bytenode's programmatic API (compileFile) rather than spawning its CLI.
// More portable across npm layouts and avoids a child-process round-trip.
const bytenode = require("bytenode");

const major = process.versions.node.split(".")[0];
const targetDir = join(distDir, `node-${major}`);

async function compile(inputRel, outputName) {
  const input = join(distDir, inputRel);
  console.log(`[bytenode] compiling ${inputRel} for Node ${major}`);

  // compileFile writes <input>.jsc next to the input.
  await bytenode.compileFile({ filename: input, output: `${input}.jsc` });

  const finalPath = join(targetDir, outputName);
  renameSync(`${input}.jsc`, finalPath);

  // Remove the source .js/.cjs and its sourcemap — they must not ship.
  rmSync(input, { force: true });
  rmSync(`${input}.map`, { force: true });
}

mkdirSync(targetDir, { recursive: true });

await compile("index.cjs", "index.jsc");
await compile("cli.cjs", "cli.jsc");

// tsup also emits dist/index.js (ESM). It must NOT ship as-is — it would expose
// scanner source bundled by tsup. Delete it; the ESM loader below replaces it.
rmSync(join(distDir, "index.js"), { force: true });

// Install loader files in place of the now-deleted tsup outputs.
// These tiny dispatchers ship as the package's `main` / `module` / `bin` entries
// and pick the correct .jsc at runtime based on process.versions.node.
console.log("[bytenode] installing loader files");
copyFileSync(join(loaderDir, "index.cjs"), join(distDir, "index.cjs"));
copyFileSync(join(loaderDir, "index.js"), join(distDir, "index.js"));
copyFileSync(join(loaderDir, "cli.cjs"), join(distDir, "cli.cjs"));

console.log(`[bytenode] done. Output: dist/node-${major}/{index,cli}.jsc + loaders`);
