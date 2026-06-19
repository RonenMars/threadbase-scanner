import type { ConversationMeta, SearchMatch } from "./types";

// Build the per-field match snippets for a search hit. Shared by the in-memory
// FlexSearch indexer and the persistent FTS backend so search() returns
// identical SearchMatch output regardless of which engine ran the query.
export function generateMatches(meta: ConversationMeta, query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const lowerQuery = query.toLowerCase();

  const fields: [string, string][] = [
    ["contentSnippet", meta.contentSnippet],
    ["projectName", meta.projectName],
    ["sessionId", meta.sessionId],
    ["sessionName", meta.sessionName],
    ["account", meta.account],
    ["model", meta.model || ""],
    ["gitBranch", meta.gitBranch || ""],
    ["toolNames", meta.toolNames.join(" ")],
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
