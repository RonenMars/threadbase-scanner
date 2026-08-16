import { extractThinking } from "./parser";
import { cleanSystemTags } from "./tags";

// The derived search corpus: one document per conversation, split into three
// independently budgeted buckets so a later user message always lands in `text`
// rather than after previously-indexed tool output. Assembled into FTS body
// columns (persistent) or one combined string (FlexSearch).
//
// Budgets are JavaScript string lengths (UTF-16 code units), NOT bytes. ASCII
// makes the two coincide; Hebrew/CJK/emoji cost 2-3 UTF-8 bytes per unit, so a
// 64K `textMax` can hold ~128-192 KB on disk. Size index-growth estimates from
// that, and don't describe these as byte caps.
export const SEARCH_BUDGET = {
  textMax: 64 * 1024,
  thinkingMax: 32 * 1024,
  toolsMax: 32 * 1024,

  toolPayloadMax: 4 * 1024,
} as const;

export interface SearchDocument {
  text: string;
  thinking: string;
  tools: string;
}

// Same shape as SearchDocument, but holding only the material extracted from
// newly-read lines — what gets tail-appended onto the durable buckets.
export type SearchDocumentDelta = SearchDocument;

const SEP = "\n\n";

export function emptySearchDocument(): SearchDocument {
  return { text: "", thinking: "", tools: "" };
}

export function isEmptyDelta(delta: SearchDocumentDelta): boolean {
  return !delta.text && !delta.thinking && !delta.tools;
}

export function searchDocumentsEqual(a: SearchDocument, b: SearchDocument): boolean {
  return a.text === b.text && a.thinking === b.thinking && a.tools === b.tools;
}

// Tail-biased append: each bucket is a sliding window over the NEWEST material.
// Head-biased fill (stop once full) would freeze a conversation the moment it
// crossed the budget — the same bug as the old 5 KB contentSnippet, just larger,
// and it would miss exactly the actively-growing conversations search exists for.
export function appendSearchDelta(doc: SearchDocument, delta: SearchDocumentDelta): SearchDocument {
  return {
    text: tailAppend(doc.text, delta.text, SEARCH_BUDGET.textMax),
    thinking: tailAppend(doc.thinking, delta.thinking, SEARCH_BUDGET.thinkingMax),
    tools: tailAppend(doc.tools, delta.tools, SEARCH_BUDGET.toolsMax),
  };
}

// ponytail: slice(-max) can cut mid-token; the truncated head token simply
// doesn't match. Grapheme/token-aware windowing isn't worth it for v1.
function tailAppend(current: string, incoming: string, max: number): string {
  if (!incoming) return current;
  const joined = current ? current + SEP + incoming : incoming;
  return joined.length <= max ? joined : joined.slice(-max);
}

// Flatten to one string for the in-memory FlexSearch index, which has a single
// body field. The persistent path keeps the buckets as separate FTS columns
// instead (concatenating there would double-weight body hits).
export function combineSearchContent(doc: SearchDocument): string {
  return [doc.text, doc.thinking, doc.tools].filter(Boolean).join(SEP);
}

// Truncate one tool payload before it joins the tools bucket, so a single huge
// Read/Bash/compiler dump can't consume the whole window.
export function capToolPayload(value: unknown): string {
  const raw = stringifyPayload(value);
  if (!raw) return "";
  return raw.length > SEARCH_BUDGET.toolPayloadMax
    ? raw.slice(0, SEARCH_BUDGET.toolPayloadMax)
    : raw;
}

function stringifyPayload(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// Extract the search-document delta from one already-parsed JSONL entry.
// Handles both Claude/Threadbase and Codex CLI line shapes so every indexing
// path — persistent, in-memory, both providers — shares one corpus definition.
export function extractSearchDelta(entry: Record<string, unknown>): SearchDocumentDelta {
  if (entry.type === "response_item" || entry.type === "session_meta") {
    return extractCodexDelta(entry);
  }
  return extractClaudeDelta(entry);
}

function extractClaudeDelta(entry: Record<string, unknown>): SearchDocumentDelta {
  const type = entry.type;
  if (type !== "user" && type !== "assistant") return emptySearchDocument();
  if (entry.isMeta) return emptySearchDocument();

  const msg = entry.message as Record<string, unknown> | undefined;
  const content = msg?.content;

  const tools = [
    extractClaudeToolContent(content),
    // Claude stores the rich/structured tool result at the JSONL entry's top
    // level, not inside message.content — indexing only message.content would
    // miss most real tool output (file reads, command stdout).
    capToolPayload(entry.toolUseResult),
  ]
    .filter(Boolean)
    .join(SEP);

  return {
    text: extractClaudeText(content),
    thinking: type === "assistant" ? extractThinking(content).content : "",
    tools,
  };
}

// Human/assistant prose only. Deliberately NOT parser.extractTextContent():
// that helper folds `tool_result` strings into the same string as user text,
// which would let a large tool result eat the high-priority text window.
//
// It DOES keep extractTextContent's cleanSystemTags step, and that is
// mandatory: without it every user turn's <system-reminder> (CLAUDE.md dump,
// skill listing, memory block) lands in `text`, exhausting the window in a
// couple of turns and making every conversation on the machine a hit for tokens
// that only ever appear in those wrappers.
function extractClaudeText(content: unknown): string {
  if (typeof content === "string") return cleanSystemTags(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      const cleaned = cleanSystemTags(item);
      if (cleaned) parts.push(cleaned);
    } else if (item?.type === "text" && typeof item.text === "string") {
      const cleaned = cleanSystemTags(item.text);
      if (cleaned) parts.push(cleaned);
    }
  }
  return parts.join(SEP);
}

// Tool I/O is the payload, so it is NOT tag-cleaned — stripping it as if it
// were a prompt wrapper would delete the content being indexed. The per-payload
// cap is the safety valve instead.
function extractClaudeToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item?.type === "tool_use") {
      const capped = capToolPayload(item.input);
      if (capped) parts.push(capped);
    } else if (item?.type === "tool_result") {
      const capped = capToolPayload(item.content);
      if (capped) parts.push(capped);
    }
  }
  return parts.join(SEP);
}

function extractCodexDelta(entry: Record<string, unknown>): SearchDocumentDelta {
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return emptySearchDocument();

  const ptype = payload.type as string;

  if (ptype === "function_call" || ptype === "custom_tool_call") {
    return { text: "", thinking: "", tools: capToolPayload(payload.arguments) };
  }
  if (ptype === "function_call_output" || ptype === "custom_tool_call_output") {
    return { text: "", thinking: "", tools: capToolPayload(payload.output) };
  }
  if (ptype === "reasoning") {
    return { text: "", thinking: extractCodexReasoning(payload), tools: "" };
  }
  if (ptype === "message") {
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return emptySearchDocument();
    return { text: extractCodexText(payload.content), thinking: "", tools: "" };
  }
  return emptySearchDocument();
}

// Codex reasoning carries its text under `summary` (and sometimes `content`),
// each a list of {type, text} blocks. Never a signature — there isn't one here,
// and on the Claude side the thinking signature is a base64 crypto blob that is
// pure noise in a search index.
function extractCodexReasoning(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"] as const) {
    const blocks = payload[key];
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (typeof block === "string") parts.push(block);
      else if (typeof block?.text === "string") parts.push(block.text);
    }
  }
  return parts.filter(Boolean).join(SEP);
}

function extractCodexText(content: unknown): string {
  if (typeof content === "string") return cleanSystemTags(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      const cleaned = cleanSystemTags(item);
      if (cleaned) parts.push(cleaned);
      continue;
    }
    const t = item?.type;
    if (
      (t === "input_text" || t === "output_text" || t === "text") &&
      typeof item.text === "string"
    ) {
      const cleaned = cleanSystemTags(item.text);
      if (cleaned) parts.push(cleaned);
    }
  }
  return parts.join(SEP);
}
