import FlexSearchModule from "flexsearch";

// FlexSearch has inconsistent default export across ESM/CJS
const FlexSearch = (FlexSearchModule as any).default ?? FlexSearchModule;

import { getLogger } from "./logger";
import { generateMatches } from "./search-matches";
import type { ConversationMeta, SearchResult } from "./types";

export class SearchIndexer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private index: any;
  private documents = new Map<string, ConversationMeta>();

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

  addDocument(meta: ConversationMeta): void {
    this.documents.set(meta.id, meta);
    this.index.add({
      id: meta.id,
      content: meta.contentSnippet,
      projectName: meta.projectName,
      projectPath: meta.projectPath,
      sessionId: meta.sessionId,
      sessionName: meta.sessionName,
      account: meta.account,
      model: meta.model || "",
      gitBranch: meta.gitBranch || "",
      toolNames: meta.toolNames.join(" "),
    });
  }

  buildIndex(metas: ConversationMeta[]): void {
    this.clear();
    for (const meta of metas) {
      this.addDocument(meta);
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

        const matches = generateMatches(meta, query);

        searchResults.push({ meta, score: 1, matches });
        if (searchResults.length >= limit) break;
      }
      if (searchResults.length >= limit) break;
    }

    return searchResults;
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
  updateDocument(meta: ConversationMeta): void {
    this.documents.set(meta.id, meta);
    this.index.update({
      id: meta.id,
      content: meta.contentSnippet,
      projectName: meta.projectName,
      projectPath: meta.projectPath,
      sessionId: meta.sessionId,
      sessionName: meta.sessionName,
      account: meta.account,
      model: meta.model || "",
      gitBranch: meta.gitBranch || "",
      toolNames: meta.toolNames.join(" "),
    });
  }

  removeDocument(id: string): void {
    this.documents.delete(id);
    this.index.remove(id);
  }

  clear(): void {
    this.documents.clear();
    this.index = this.createIndex();
    getLogger().trace("indexer: cleared");
  }
}
