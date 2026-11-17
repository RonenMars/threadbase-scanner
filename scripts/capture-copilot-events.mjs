#!/usr/bin/env node
// Capture a real GitHub Copilot CLI session as a sanitized live fixture, and print the shape
// facts that settle what the scanner's Copilot parser still assumes.
//
//   node scripts/capture-copilot-events.mjs <events.jsonl | session dir | session-state dir>
//        [--out __fixtures__/copilot/live/<name>.jsonl]     sanitize and copy into the repo
//   node scripts/capture-copilot-events.mjs <same path> --report   print shape facts, write nothing
//
// The path is always an argument. Nothing here looks for a Copilot home on its own, and nothing
// touches the network. The copy is the only write, and it can only land in
// __fixtures__/copilot/live/ (the guarded suite __tests__/copilot-live-fixtures.test.ts reads it).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname as osHostname, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isMainModule, repoRootFromScript } from "./lib/module.mjs";

const REPO_ROOT = repoRootFromScript(import.meta.url);
const LIVE_REL = "__fixtures__/copilot/live";
const REDACTED = "<redacted>";

// permission.completed result.kind values src/providers/copilot.ts maps (PERMISSION_DECISIONS).
// Kept as a copy because this is plain Node and cannot import the TypeScript source; a test pins it.
export const KNOWN_PERMISSION_KINDS = [
  "approved",
  "approved-for-location",
  "denied-interactively-by-user",
  "cancelled",
];

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/**
 * Parse JSONL text into event objects. Blank lines are skipped. A line that is not a JSON object
 * is an error carrying its 1-based line number; the line's content is never echoed, because it
 * may be the very thing that must not leak.
 */
export function parseEvents(text) {
  const events = [];
  const errors = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const lineNo = i + 1;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push({ lineNo, reason: "not valid JSON" });
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push({ lineNo, reason: "not a JSON object" });
      return;
    }
    events.push(value);
  });
  return { events, errors };
}

function malformedMessage(source, errors) {
  const shown = errors.slice(0, 20).map((e) => `  line ${e.lineNo}: ${e.reason}`);
  const more = errors.length > 20 ? [`  ... and ${errors.length - 20} more`] : [];
  return [`${source} has ${errors.length} malformed line(s):`, ...shown, ...more].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------------------------

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const WHOLE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A key ending in `Id` (toolCallId, requestId, parentId ...). Model names live under `modelId`.
const ID_KEY_RE = /[a-z]Id$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{16,}$/;

const UNIX_HOME_RE = /\/(?:Users|home)\/([^/\s"'\\:;,)]+)/g;
const WIN_HOME_RE = /[A-Za-z]:[\\/]Users[\\/]([^\\/\s"']+)/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PRIVATE_HOST_RE =
  /[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|corp|intranet|home)\b/gi;
const ASSIGNMENT_RE =
  /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*)=[^\s"']+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const PREFIXED_TOKEN_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
const BASE64_RE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

// Words that are placeholders themselves or would mangle one.
const NEVER_A_NAME = new Set(["user", "users", "home", "root", "redacted"]);
const MIN_TERM = 3;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mixed-case, digit-bearing 32+ runs only: a long path or identifier is lower-case or has no
// digits, random base64 almost never is.
const looksRandom = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);

function termRegex(terms) {
  const clean = [...new Set(terms)]
    .filter((t) => typeof t === "string" && t.length >= MIN_TERM && !NEVER_A_NAME.has(t.toLowerCase()));
  if (clean.length === 0) return null;
  return new RegExp(`(?<![A-Za-z0-9_])(?:${clean.map(escapeRe).join("|")})(?![A-Za-z0-9_])`, "gi");
}

function walk(value, key, onString, onKey) {
  if (typeof value === "string") return onString(value, key);
  if (Array.isArray(value)) return value.map((v) => walk(v, key, onString, onKey));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[onKey(k)] = walk(v, k, onString, onKey);
    return out;
  }
  return value;
}

function collectUsernames(events) {
  const found = new Set();
  const scan = (s) => {
    for (const re of [UNIX_HOME_RE, WIN_HOME_RE]) {
      for (const m of s.matchAll(re)) found.add(m[1]);
    }
    return s;
  };
  for (const e of events) walk(e, "", scan, scan);
  return [...found];
}

function freeTextCount(event) {
  const d = event.data;
  if (d === null || typeof d !== "object") return 0;
  const texts = [];
  if (event.type === "user.message" || event.type === "assistant.message") texts.push(d.content);
  if (event.type === "tool.execution_complete" && d.result && typeof d.result === "object") {
    texts.push(d.result.content, d.result.detailedContent);
  }
  return texts.filter((t) => typeof t === "string" && t.length > 0).length;
}

/**
 * Sanitize parsed events. Returns new events (the input is not modified) and per-class counts.
 *
 * Structure survives: event order, `type`, every key name and order, booleans and numbers, and any
 * string that is not a path, name, address or secret. Ids are mapped, not redacted, so that a
 * toolCallId or requestId still pairs across events.
 */
export function sanitizeEvents(events, opts = {}) {
  const counts = { ids: 0, paths: 0, usernames: 0, hostnames: 0, emails: 0, tokens: 0, freeText: 0 };
  const uuidMap = new Map();
  const opaqueMap = new Map();

  const usernameRe = termRegex([...collectUsernames(events), ...(opts.usernames ?? [])]);
  const hostnameRe = termRegex(opts.hostnames ?? []);

  // Counts only replacements that changed something.
  const swap = (s, re, replacement, field) =>
    s.replace(re, (...m) => {
      const r = typeof replacement === "function" ? replacement(...m) : replacement;
      if (r !== m[0]) counts[field]++;
      return r;
    });

  const uuidPlaceholder = (u) => {
    const k = u.toLowerCase();
    if (!uuidMap.has(k)) {
      uuidMap.set(k, `00000000-0000-4000-8000-${String(uuidMap.size + 1).padStart(12, "0")}`);
    }
    return uuidMap.get(k);
  };

  const onString = (value, key) => {
    let s = value;
    if (
      ID_KEY_RE.test(key) &&
      !key.startsWith("model") &&
      OPAQUE_ID_RE.test(s) &&
      !WHOLE_UUID_RE.test(s)
    ) {
      if (!opaqueMap.has(s)) opaqueMap.set(s, `${key}-${opaqueMap.size + 1}`);
      return opaqueMap.get(s);
    }
    UUID_RE.lastIndex = 0;
    s = s.replace(UUID_RE, uuidPlaceholder);
    s = swap(s, WIN_HOME_RE, "/home/user", "paths");
    s = swap(s, UNIX_HOME_RE, "/home/user", "paths");
    s = swap(s, EMAIL_RE, REDACTED, "emails");
    if (hostnameRe) s = swap(s, hostnameRe, REDACTED, "hostnames");
    s = swap(s, PRIVATE_HOST_RE, REDACTED, "hostnames");
    s = swap(s, ASSIGNMENT_RE, (_m, name) => `${name}=${REDACTED}`, "tokens");
    s = swap(s, BEARER_RE, `Bearer ${REDACTED}`, "tokens");
    s = swap(s, PREFIXED_TOKEN_RE, REDACTED, "tokens");
    s = swap(s, HEX_RE, REDACTED, "tokens");
    s = swap(s, BASE64_RE, (m) => (looksRandom(m) ? REDACTED : m), "tokens");
    if (usernameRe) s = swap(s, usernameRe, "user", "usernames");
    return s;
  };
  const onKey = (k) => onString(k, "");

  const out = events.map((e) => walk(e, "", onString, onKey));
  for (const e of out) counts.freeText += freeTextCount(e);
  counts.ids = uuidMap.size + opaqueMap.size;
  return { events: out, counts };
}

// ---------------------------------------------------------------------------------------------
// Input and output paths
// ---------------------------------------------------------------------------------------------

/** A file is used as is. A directory holding events.jsonl is that session; otherwise the newest
 * `<dir>/*\/events.jsonl` wins. Never searches anywhere the caller did not name. */
export function resolveInput(path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  if (!statSync(path).isDirectory()) return path;
  const direct = join(path, "events.jsonl");
  if (existsSync(direct)) return direct;
  const candidates = readdirSync(path, { withFileTypes: true })
    .map((d) => join(path, d.name, "events.jsonl"))
    .filter((f) => existsSync(f))
    .map((f) => ({ f, mtime: statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) throw new Error(`no events.jsonl found in ${path}`);
  return candidates[0].f;
}

const pad = (n) => String(n).padStart(2, "0");

/** The one place a capture may be written: a *.jsonl directly inside __fixtures__/copilot/live/. */
export function resolveOut(out, repoRoot = REPO_ROOT, now = new Date()) {
  const liveDir = join(repoRoot, ...LIVE_REL.split("/"));
  const name =
    out ??
    `capture-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
      `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.jsonl`;
  const abs = out === undefined ? join(liveDir, name) : resolve(repoRoot, out);
  const inside = dirname(abs) === liveDir && /^[A-Za-z0-9][\w.-]*\.jsonl$/.test(basename(abs));
  if (!inside) {
    throw new Error(`--out must be a .jsonl file directly inside ${LIVE_REL}/ (got ${relative(repoRoot, abs) || abs})`);
  }
  return abs;
}

function noticeFor(outPath, counts) {
  return [
    "REVIEW BEFORE COMMIT",
    `Wrote ${outPath}`,
    "Replaced values:",
    ...["ids", "paths", "usernames", "hostnames", "emails", "tokens"].map(
      (k) => `  ${k}: ${counts[k]}`,
    ),
    `Free-text values kept as typed (user and assistant messages, tool output): ${counts.freeText}`,
    "Open the file and read every user.message, assistant.message and tool output value.",
    "Edit or remove anything private (names, repo or customer names, internal URLs, code), then run",
    "this script again with --report on the written file, and only then commit it.",
  ].join("\n");
}

function defaultTerms() {
  const usernames = [];
  const hostnames = [];
  try {
    usernames.push(userInfo().username);
  } catch {}
  try {
    const h = osHostname();
    hostnames.push(h, h.split(".")[0]);
  } catch {}
  return { usernames, hostnames };
}

/** Read, sanitize and write one capture. Throws before writing anything if the input or the
 * output path is wrong. */
export function captureFile({ input, out, repoRoot = REPO_ROOT, now, usernames, hostnames }) {
  const outPath = resolveOut(out, repoRoot, now);
  const source = resolveInput(input);
  const { events, errors } = parseEvents(readFileSync(source, "utf8"));
  if (errors.length > 0) throw new Error(malformedMessage(basename(source), errors));
  if (events.length === 0) throw new Error(`${basename(source)} has no events`);
  const defaults = defaultTerms();
  const result = sanitizeEvents(events, {
    usernames: usernames ?? defaults.usernames,
    hostnames: hostnames ?? defaults.hostnames,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${result.events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return { outPath, counts: result.counts, notice: noticeFor(outPath, result.counts) };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const bump = (map, k, by = 1) => map.set(k, (map.get(k) ?? 0) + by);
const asObject = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});

/** The facts the unconfirmed questions turn on. Plain data; formatReport prints it. */
export function reportFacts(events) {
  const typeCounts = new Map();
  const toolNames = new Map();
  const requestTool = new Map();

  for (const e of events) {
    bump(typeCounts, String(e.type));
    const d = asObject(e.data);
    if (e.type === "assistant.message" && Array.isArray(d.toolRequests)) {
      for (const r of d.toolRequests) {
        const req = asObject(r);
        if (req.toolCallId && req.name && !toolNames.has(req.toolCallId)) {
          toolNames.set(req.toolCallId, req.name);
        }
      }
    }
    if (e.type === "tool.execution_start" && d.toolCallId && d.toolName) {
      if (!toolNames.has(d.toolCallId)) toolNames.set(d.toolCallId, d.toolName);
    }
    if (e.type === "permission.requested") {
      const id = asObject(d.permissionRequest).toolCallId ?? asObject(d.promptRequest).toolCallId;
      if (d.requestId && id) requestTool.set(d.requestId, id);
    }
  }

  const idOf = (d) =>
    d.toolCallId ??
    asObject(d.permissionRequest).toolCallId ??
    asObject(d.promptRequest).toolCallId ??
    requestTool.get(d.requestId);

  const completes = new Map(); // toolCallId -> [{ index, success }]
  const toolResults = new Map(); // tool name -> counters
  events.forEach((e, index) => {
    if (e.type !== "tool.execution_complete") return;
    const d = asObject(e.data);
    const id = d.toolCallId;
    if (id) {
      if (!completes.has(id)) completes.set(id, []);
      completes.get(id).push({ index, success: d.success });
    }
    const name = (id && toolNames.get(id)) || "(unknown tool)";
    if (!toolResults.has(name)) {
      toolResults.set(name, { total: 0, content: 0, detailed: 0, both: 0, neither: 0, empty: 0, keys: new Set() });
    }
    const t = toolResults.get(name);
    const result = asObject(d.result);
    const hasContent = typeof result.content === "string";
    const hasDetailed = typeof result.detailedContent === "string";
    t.total++;
    if (hasContent) t.content++;
    if (hasDetailed) t.detailed++;
    if (hasContent && hasDetailed) t.both++;
    if (!hasContent && !hasDetailed) t.neither++;
    if (result.content === "" || result.detailedContent === "") t.empty++;
    for (const k of Object.keys(result)) t.keys.add(k);
  });

  const kinds = new Map();
  const sources = new Map();
  const perKind = new Map(); // kind -> { total, followed, success: Map }
  let withoutId = 0;
  let resolvedByRequest = 0;
  let feedback = 0;
  let reason = 0;
  let permissionCompleted = 0;
  events.forEach((e, index) => {
    if (e.type !== "permission.completed") return;
    permissionCompleted++;
    const d = asObject(e.data);
    const result = asObject(d.result);
    const kind = typeof result.kind === "string" ? result.kind : "(missing)";
    bump(kinds, kind);
    bump(sources, typeof d.decisionSource === "string" ? d.decisionSource : "(none)");
    if (result.feedback) feedback++;
    if (result.reason) reason++;
    if (!d.toolCallId) {
      withoutId++;
      if (requestTool.has(d.requestId)) resolvedByRequest++;
    }
    if (!perKind.has(kind)) perKind.set(kind, { total: 0, followed: 0, success: new Map() });
    const k = perKind.get(kind);
    k.total++;
    const id = idOf(d);
    const next = id ? (completes.get(id) ?? []).find((c) => c.index > index) : undefined;
    if (next) {
      k.followed++;
      bump(k.success, String(next.success ?? "(absent)"));
    }
  });

  const askIds = new Set([...toolNames].filter(([, n]) => n === "ask_user").map(([id]) => id));
  const ask = { calls: askIds.size, start: 0, complete: 0, completeSuccess: new Map(), requested: 0, permissionCompleted: 0, other: new Map() };
  for (const e of events) {
    const d = asObject(e.data);
    const id = idOf(d);
    if (!id || !askIds.has(id)) continue;
    if (e.type === "tool.execution_start") ask.start++;
    else if (e.type === "tool.execution_complete") {
      ask.complete++;
      bump(ask.completeSuccess, String(d.success ?? "(absent)"));
    } else if (e.type === "permission.requested") ask.requested++;
    else if (e.type === "permission.completed") ask.permissionCompleted++;
    else if (/^(permission\.|tool\.execution_)/.test(String(e.type))) bump(ask.other, e.type);
  }

  return {
    eventCount: events.length,
    typeCounts,
    permission: { total: permissionCompleted, kinds, sources, withoutId, resolvedByRequest, feedback, reason, perKind },
    ask,
    toolResults,
  };
}

const sortedPairs = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const joinCounts = (map) => sortedPairs(map).map(([k, v]) => `${k}=${v}`).join(", ") || "none";

const successCounts = (map) =>
  sortedPairs(map)
    .map(([k, v]) => `success=${k}:${v}`)
    .join(", ");

export function formatReport(facts) {
  const p = facts.permission;
  const unknown = [...p.kinds.keys()].filter((k) => !KNOWN_PERMISSION_KINDS.includes(k)).sort();
  const lines = [
    "COPILOT EVENT SHAPE REPORT",
    `events: ${facts.eventCount}`,
    `event types: ${joinCounts(facts.typeCounts)}`,
    "",
    `permission.completed: ${p.total}`,
    `  kinds: ${joinCounts(p.kinds)}`,
    unknown.length > 0
      ? `  UNKNOWN KINDS (not mapped by the scanner): ${unknown.join(", ")}`
      : "  every kind is mapped by the scanner",
    `  decisionSource: ${joinCounts(p.sources)}`,
    `  without toolCallId: ${p.withoutId} (resolved through requestId: ${p.resolvedByRequest})`,
    `  with feedback: ${p.feedback}, with reason: ${p.reason}`,
    "  per kind, and whether a later tool.execution_complete shares its toolCallId:",
  ];
  for (const [kind, k] of sortedPairs(p.perKind)) {
    const success = k.followed > 0 ? ` (${successCounts(k.success)})` : "";
    lines.push(`    ${kind}: ${k.total} total, ${k.followed} followed by tool.execution_complete${success}`);
  }
  const a = facts.ask;
  lines.push(
    "",
    `ask_user (tool calls: ${a.calls})`,
    `  tool.execution_start: ${a.start}`,
    `  tool.execution_complete: ${a.complete}${a.complete > 0 ? ` (${successCounts(a.completeSuccess)})` : ""}`,
    `  permission.requested: ${a.requested}`,
    `  permission.completed: ${a.permissionCompleted}`,
    `  other permission.* and tool.execution_* events tied to ask_user: ${joinCounts(a.other)}`,
    "",
    "tool.execution_complete by tool (content / detailedContent are keys of data.result):",
  );
  for (const [name, t] of sortedPairs(facts.toolResults)) {
    lines.push(
      `  ${name}: ${t.total} total; content=${t.content} detailedContent=${t.detailed} both=${t.both} neither=${t.neither} (empty strings: ${t.empty}); result keys: ${[...t.keys].sort().join(", ") || "none"}`,
    );
  }
  if (facts.toolResults.size === 0) lines.push("  none");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: node scripts/capture-copilot-events.mjs <events.jsonl | session dir | session-state dir> [--out ${LIVE_REL}/<name>.jsonl]
       node scripts/capture-copilot-events.mjs <same path> --report`;

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let input;
  let out;
  let report = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") report = true;
    else if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a.startsWith("--") || input !== undefined) {
      io.stderr.write(`${USAGE}\n`);
      return 2;
    } else input = a;
  }
  if (input === undefined || (out === undefined && argv.includes("--out"))) {
    io.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    if (report) {
      const source = resolveInput(input);
      const { events, errors } = parseEvents(readFileSync(source, "utf8"));
      if (errors.length > 0) throw new Error(malformedMessage(basename(source), errors));
      io.stdout.write(`${formatReport(reportFacts(events))}\n`);
      return 0;
    }
    const r = captureFile({ input, out });
    io.stdout.write(`${r.notice}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`capture-copilot-events: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
