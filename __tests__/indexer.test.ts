import { beforeEach, describe, expect, it } from "vitest";
import { SearchIndexer } from "../src/indexer";
import type { ConversationMeta } from "../src/types";

function makeMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: "test",
    filePath: "/test.jsonl",
    sessionId: "sess-1",
    sessionName: "test-session",
    projectPath: "/project",
    projectName: "my-project",
    account: "default",
    timestamp: "2026-01-01T00:00:00Z",
    messageCount: 5,
    lastMessageSender: "user",
    preview: "test preview",
    contentSnippet: "some content about authentication and login",
    gitBranch: "main",
    model: "claude-sonnet-4-20250514",
    isSubagent: false,
    parentSessionId: null,
    isTeammate: false,
    teamName: null,
    toolNames: ["Edit", "Read"],
    ...overrides,
  };
}

describe("SearchIndexer", () => {
  let indexer: SearchIndexer;

  beforeEach(() => {
    indexer = new SearchIndexer();
  });

  it("indexes and searches documents", () => {
    indexer.addDocument(makeMeta({ id: "a", contentSnippet: "fix the authentication bug" }));
    indexer.addDocument(makeMeta({ id: "b", contentSnippet: "add new feature" }));

    const results = indexer.search("authentication");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].meta.id).toBe("a");
  });

  it("searches by project name", () => {
    indexer.addDocument(makeMeta({ id: "a", projectName: "frontend-app" }));
    indexer.addDocument(makeMeta({ id: "b", projectName: "backend-api" }));

    const results = indexer.search("frontend");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].meta.projectName).toBe("frontend-app");
  });

  it("returns recent conversations for empty query", () => {
    indexer.addDocument(makeMeta({ id: "old", timestamp: "2025-01-01T00:00:00Z" }));
    indexer.addDocument(makeMeta({ id: "new", timestamp: "2026-06-01T00:00:00Z" }));

    const results = indexer.search("");
    expect(results[0].meta.id).toBe("new");
  });

  it("returns correct document count", () => {
    indexer.addDocument(makeMeta({ id: "a" }));
    indexer.addDocument(makeMeta({ id: "b" }));
    expect(indexer.getDocumentCount()).toBe(2);
  });

  it("clears index", () => {
    indexer.addDocument(makeMeta({ id: "a" }));
    indexer.clear();
    expect(indexer.getDocumentCount()).toBe(0);
  });

  it("builds index from array", () => {
    indexer.buildIndex([makeMeta({ id: "a" }), makeMeta({ id: "b" })]);
    expect(indexer.getDocumentCount()).toBe(2);
  });

  it("generates context-aware preview snippets", () => {
    const longContent =
      "The quick brown fox jumped over the lazy dog and then proceeded to fix the authentication bug in the login module which was causing failures";
    indexer.addDocument(makeMeta({ id: "a", contentSnippet: longContent }));

    const results = indexer.search("authentication");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].matches.length).toBeGreaterThanOrEqual(1);
    expect(results[0].matches[0].snippet).toContain("authentication");
  });
});
