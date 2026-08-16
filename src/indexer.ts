import FlexSearchModule from "flexsearch";

// FlexSearch has inconsistent default export across ESM/CJS
const FlexSearch = (FlexSearchModule as any).default ?? FlexSearchModule;

import { getLogger } from "./logger";
import { buildContentMatch, generateMatches } from "./search-matches";
import type { ConversationMeta, SearchMatch, SearchResult } from "./types";

export class SearchIndexer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private index: any;
  private documents = new Map<string, ConversationMeta>();
  // The indexed body per conversation, kept so a hit can produce a real excerpt
  // instead of falling back to an unrelated preview. Sized by the caller (the
  // scanner tail-caps it to the content tier) — see the note on addDocument.
  private searchContents = new Map<string, string>();

  constructor() {
    this.index = this.createIndex();
  }

  private createIndex() {
    return new (FlexSearch as any).Document({
      document: {
        id: "id",
        index: [
          "content",
          "projectName",
          "projectPath",
          "sessionId",
          "sessionName",
          "account",
          "model",
          "gitBranch",
          "toolNames",
        ],
        store: ["id"],
      },
      tokenize: "forward",
      resolution: 9,
      cache: 100,
    });
  }

  // `searchContent` is the combined search document (text + thinking + tools),
  // NOT meta.contentSnippet.
  //
  // It arrives pre-capped. This index is `tokenize: "forward"` at resolution 9,
  // which stores every prefix of every token, so it is a resident-memory
  // structure whose cost is very different from the on-disk FTS index. Feeding
  // it the full ~128 KB budget across a few hundred conversations would be a
  // multi-hundred-MB-to-GB index. The scanner therefore caps this to the active
  // tier's snippetMax and accepts that `persistent: false` has lower recall than
  // SQLite — an honest, documented divergence rather than a silent one.
  addDocument(meta: ConversationMeta, searchContent = ""): void {
    this.documents.set(meta.id, meta);
    this.searchContents.set(meta.id, searchContent);
    this.index.add(toIndexDoc(meta, searchContent));
  }

  buildIndex(metas: ConversationMeta[], searchContents?: Map<string, string>): void {
    this.clear();
    for (const meta of metas) {
      this.addDocument(meta, searchContents?.get(meta.id) ?? "");
    }
    getLogger().debug({ docCount: metas.length }, "indexer: built");
  }

  search(query: string, options?: { fields?: string[]; limit?: number }): SearchResult[] {
    const limit = options?.limit ?? 50;

    if (!query.trim()) {
      return this.getRecent(limit);
    }

    const results = this.index.search(query, { limit: limit * 2, enrich: true });

    const seen = new Set<string>();
    const searchResults: SearchResult[] = [];

    for (const fieldResult of results) {
      if (!fieldResult.result) continue;
      for (const item of fieldResult.result) {
        const id = typeof item === "object" ? (item as { id: string }).id : String(item);
        if (seen.has(id)) continue;
        seen.add(id);

        const meta = this.documents.get(id);
        if (!meta) continue;

        searchResults.push({
          meta,
          score: 1,
          matches: this.matchesFor(meta, query),
        });
        if (searchResults.length >= limit) break;
      }
      if (searchResults.length >= limit) break;
    }

    return searchResults;
  }

  // Body context first (that is what explains why the result appeared), then any
  // metadata matches. Only when neither hits does generateMatches' preview
  // fallback stand in.
  private matchesFor(meta: ConversationMeta, query: string): SearchMatch[] {
    const contentMatch = buildContentMatch(this.searchContents.get(meta.id) ?? "", query);
    const metaMatches = generateMatches(meta, query);
    if (!contentMatch) return metaMatches;
    return [contentMatch, ...metaMatches.filter((m) => m.field !== "preview")];
  }

  private getRecent(limit: number): SearchResult[] {
    return Array.from(this.documents.values())
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
      .map((meta) => ({
        meta,
        score: 1,
        matches: [{ field: "timestamp", snippet: meta.preview }],
      }));
  }

  getDocumentCount(): number {
    return this.documents.size;
  }

  // Replace an already-indexed document in place. FlexSearch's `add` does not
  // overwrite an existing id, so a single-file refresh must go through
  // `update` to avoid stale matches lingering in the index.
  updateDocument(meta: ConversationMeta, searchContent = ""): void {
    this.documents.set(meta.id, meta);
    this.searchContents.set(meta.id, searchContent);
    this.index.update(toIndexDoc(meta, searchContent));
  }

  removeDocument(id: string): void {
    this.documents.delete(id);
    this.searchContents.delete(id);
    this.index.remove(id);
  }

  clear(): void {
    this.documents.clear();
    this.searchContents.clear();
    this.index = this.createIndex();
    getLogger().trace("indexer: cleared");
  }
}

function toIndexDoc(meta: ConversationMeta, searchContent: string) {
  return {
    id: meta.id,
    content: searchContent,
    projectName: meta.projectName,
    projectPath: meta.projectPath,
    sessionId: meta.sessionId,
    sessionName: meta.sessionName,
    account: meta.account,
    model: meta.model || "",
    gitBranch: meta.gitBranch || "",
    toolNames: meta.toolNames.join(" "),
  };
}
