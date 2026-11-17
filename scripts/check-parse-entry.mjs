#!/usr/bin/env node
// Run after the build: `@threadbase-sh/scanner/parse` must load none of the
// heavy runtime (native SQLite, watcher, logger, globbing) or the Node file
// APIs, and must resolve through package.json `exports` for a consumer.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = new Set(
  [
    "better-sqlite3",
    "chokidar",
    "pino",
    "pino-pretty",
    "fast-glob",
    "flexsearch",
    "commander",
    "fs",
    "readline",
  ].flatMap((m) => [m, `node:${m}`]),
);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

const failures = [];
const seen = new Set();
function check(file) {
  if (seen.has(file)) return;
  seen.add(file);
  for (const [, spec] of readFileSync(file, "utf-8").matchAll(SPECIFIER)) {
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (FORBIDDEN.has(pkg)) failures.push(`${file}: loads "${spec}"`);
    else if (spec.startsWith(".")) check(resolve(dirname(file), spec));
  }
}
check(join(root, "dist/parse.js"));
check(join(root, "dist/parse.cjs"));

// Resolve the subpath by package name from outside the repo, both module systems.
const consumer = mkdtempSync(join(tmpdir(), "tb-parse-consumer-"));
try {
  const name = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).name;
  mkdirSync(join(consumer, "node_modules", dirname(name)), { recursive: true });
  symlinkSync(root, join(consumer, "node_modules", name), "dir");
  writeFileSync(
    join(consumer, "probe.mjs"),
    `import { parseJsonlLine, createJsonlParseState } from "${name}/parse";
import { createRequire } from "node:module";
const cjs = createRequire(import.meta.url)("${name}/parse");
for (const m of [{ parseJsonlLine, createJsonlParseState }, cjs]) {
  const msg = m.parseJsonlLine('{"type":"user","message":{"role":"user","content":"hi"}}', m.createJsonlParseState());
  if (msg?.text !== "hi") throw new Error("parseJsonlLine via ${name}/parse returned " + JSON.stringify(msg));
}`,
  );
  execFileSync(process.execPath, ["probe.mjs"], { cwd: consumer, stdio: "inherit" });
} catch (err) {
  failures.push(`consumer import of the ./parse subpath failed: ${err.message}`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`check-parse-entry: ${failures.length} problem(s)\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-parse-entry: ok (${seen.size} file(s) scanned, subpath resolves)`);
