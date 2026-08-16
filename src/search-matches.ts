import type { ConversationMeta, SearchHighlight, SearchMatch } from "./types";

// Delimiters handed to FTS5 snippet() to mark matched tokens, stripped again
// before the excerpt reaches a caller. Control characters (STX/ETX) rather than
// a textual sentinel like [[HIT]]: a transcript can legitimately contain wiki
// link syntax, and a collision would silently shift every highlight offset.
export const FTS_HIT_OPEN = "\u0002";
export const FTS_HIT_CLOSE = "\u0003";

// Tokens of context FTS5 puts around a hit. Clients decide final layout.
export const FTS_SNIPPET_TOKENS = 16;

export const FTS_ELLIPSIS = "…";

// Field name used for any conversation-body hit, whichever body column matched.
// Column identity (text/thinking/tools) is an indexing detail; consumers only
// need to distinguish "body" from "metadata".
export const CONTENT_FIELD = "content";

// Convert one raw FTS5 snippet() string into plain text plus highlight ranges.
// Returns null when the column carried no marked hit — snippet() returns the
// head of a column even when the match was in a different column, so marker
// presence is the only reliable "did THIS column match" signal.
export function parseFtsSnippet(
  raw: string | null | undefined,
): { snippet: string; highlights: SearchHighlight[] } | null {
  if (!raw?.includes(FTS_HIT_OPEN)) return null;

  const highlights: SearchHighlight[] = [];
  let snippet = "";
  let openAt = -1;

  for (const ch of raw) {
    if (ch === FTS_HIT_OPEN) {
      openAt = snippet.length;
      continue;
    }
    if (ch === FTS_HIT_CLOSE) {
      if (openAt >= 0 && snippet.length > openAt) {
        highlights.push({ start: openAt, end: snippet.length });
      }
      openAt = -1;
      continue;
    }
    snippet += ch;
  }

  return highlights.length > 0 ? { snippet, highlights } : null;
}

// Per-field match snippets for a METADATA hit. Body context no longer comes from
// here: it comes from FTS5 snippet() (persistent) or buildContentMatch()
// (in-memory), because meta.contentSnippet is a 5 KB head-biased preview, not
// the search corpus.
//
// Field ids are camelCase, matching ConversationMeta — never the snake_case FTS
// column names. Consumers switch on matches[].field, so the two vocabularies
// must not mix. Order follows the documented precedence.
export function generateMatches(meta: ConversationMeta, query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const lowerQuery = query.toLowerCase();

  const fields: [string, string][] = [
    ["sessionName", meta.sessionName],
    ["projectName", meta.projectName],
    ["gitBranch", meta.gitBranch || ""],
    ["toolNames", meta.toolNames.join(" ")],
    ["model", meta.model || ""],
    ["account", meta.account],
    ["sessionId", meta.sessionId],
  ];

  for (const [field, value] of fields) {
    const idx = value.toLowerCase().indexOf(lowerQuery);
    if (idx !== -1) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(value.length, idx + query.length + 120);
      let snippet = value.slice(start, end);
      if (start > 0) snippet = `...${snippet}`;
      if (end < value.length) snippet = `${snippet}...`;
      matches.push({ field, snippet });
    }
  }

  return matches.length > 0 ? matches : [{ field: "preview", snippet: meta.preview }];
}

// Body context for the in-memory path, which has no FTS5 snippet(). Locates the
// query literally in the combined search document and returns the same
// {field, snippet, highlights} shape the persistent path produces.
export function buildContentMatch(searchContent: string, query: string): SearchMatch | null {
  if (!searchContent || !query.trim()) return null;
  const idx = searchContent.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;

  const start = Math.max(0, idx - 80);
  const end = Math.min(searchContent.length, idx + query.length + 120);
  const body = searchContent.slice(start, end).replace(/\s+/g, " ").trim();

  // Measure the hit AFTER the whitespace collapse, so the offsets describe the
  // string actually being returned.
  const hitAt = body.toLowerCase().indexOf(query.toLowerCase());
  const prefix = start > 0 ? FTS_ELLIPSIS : "";
  const suffix = end < searchContent.length ? FTS_ELLIPSIS : "";
  const snippet = `${prefix}${body}${suffix}`;

  const highlights: SearchHighlight[] =
    hitAt === -1
      ? []
      : [{ start: hitAt + prefix.length, end: hitAt + prefix.length + query.length }];

  return { field: CONTENT_FIELD, snippet, highlights };
}
