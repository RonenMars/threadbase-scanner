#!/usr/bin/env node
// Extract repo-relative paths touched by the last agent turn in a transcript
// JSONL. Reads transcript path from argv[1] or stdin JSON hook fields
// (transcript_path). Prints one path per line; empty stdout if none.

import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "StrReplace",
  "EditNotebook",
  "Delete",
  "create_file",
  "search_replace",
]);

function loadTranscript(path) {
  if (!path || !existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore torn / non-JSON lines
    }
  }
  return rows;
}

function roleOf(row) {
  if (row.type === "user" || row.role === "user") return "user";
  if (row.type === "assistant" || row.role === "assistant") return "assistant";
  return null;
}

function contentBlocks(row) {
  const msg = row.message ?? row;
  const content = msg?.content;
  if (Array.isArray(content)) return content;
  if (Array.isArray(row.content)) return row.content;
  // Some hosts emit tool_use rows at top level after assistant text blocks
  if (row.type === "tool_use" || row.name) return [row];
  return [];
}

function pathsFromInput(input) {
  if (!input || typeof input !== "object") return [];
  const out = [];
  for (const key of ["file_path", "path", "target_notebook", "filePath", "file"]) {
    const v = input[key];
    if (typeof v === "string" && v) out.push(v);
  }
  // MultiEdit / batch shapes
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e.path === "string") out.push(e.path);
      if (e && typeof e.file_path === "string") out.push(e.file_path);
    }
  }
  if (Array.isArray(input.files)) {
    for (const f of input.files) {
      if (typeof f === "string") out.push(f);
      else if (f && typeof f.path === "string") out.push(f.path);
    }
  }
  return out;
}

function pathsFromRow(row) {
  const paths = [];
  for (const block of contentBlocks(row)) {
    if (!block || typeof block !== "object") continue;
    const isTool =
      block.type === "tool_use" ||
      block.type === "tool_call" ||
      typeof block.name === "string";
    if (!isTool) continue;
    const name = block.name ?? block.toolName ?? "";
    // Prefer known write tools; still accept path-bearing unknown tools.
    const input = block.input ?? block.arguments ?? block.params ?? {};
    const found = pathsFromInput(input);
    if (found.length === 0) continue;
    if (WRITE_TOOLS.has(name) || found.length > 0) {
      // Skip pure reads when we can identify them
      if (name === "Read" || name === "read_file" || name === "Glob" || name === "Grep") {
        continue;
      }
      paths.push(...found);
    }
  }
  return paths;
}

function lastTurnPaths(rows) {
  let lastUser = -1;
  for (let i = 0; i < rows.length; i++) {
    if (roleOf(rows[i]) === "user") lastUser = i;
  }
  const start = lastUser + 1;
  const paths = [];
  for (let i = start; i < rows.length; i++) {
    const role = roleOf(rows[i]);
    // Include assistant rows and orphan tool_use rows after the last user turn
    if (role === "user") break;
    paths.push(...pathsFromRow(rows[i]));
  }
  return paths;
}

function toRepoRelative(repoRoot, absOrRel) {
  const abs = isAbsolute(absOrRel) ? absOrRel : resolve(repoRoot, absOrRel);
  const rel = relative(repoRoot, abs);
  if (!rel || rel.startsWith("..")) return null;
  return rel;
}

function main() {
  const repoRoot = process.env.VERIFY_STOP_ROOT || process.cwd();
  let transcriptPath = process.argv[2] || process.env.VERIFY_STOP_TRANSCRIPT || "";

  if (!transcriptPath && !process.stdin.isTTY) {
    try {
      const raw = readFileSync(0, "utf8").trim();
      if (raw) {
        const hook = JSON.parse(raw);
        transcriptPath = hook.transcript_path || hook.transcriptPath || "";
      }
    } catch {
      // no stdin payload
    }
  }

  if (!transcriptPath) {
    process.exit(0);
  }

  const rows = loadTranscript(transcriptPath);
  const seen = new Set();
  for (const p of lastTurnPaths(rows)) {
    const rel = toRepoRelative(repoRoot, p);
    if (rel) seen.add(rel);
  }
  for (const p of [...seen].sort()) {
    process.stdout.write(`${p}\n`);
  }
}

main();
