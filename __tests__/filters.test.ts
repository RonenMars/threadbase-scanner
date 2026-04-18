import { describe, expect, it } from "vitest";
import {
  applyAccountFilter,
  applyIncludeFilter,
  applyPagination,
  applyProjectFilter,
  applySinceFilter,
  applySort,
  parseSinceCutoff,
} from "../src/filters";
import type { ConversationMeta } from "../src/types";

function makeMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: "test",
    filePath: "/test.jsonl",
    sessionId: "sess-1",
    sessionName: "",
    projectPath: "/project",
    projectName: "project",
    account: "default",
    timestamp: "2026-01-01T00:00:00Z",
    messageCount: 5,
    lastMessageSender: "user",
    preview: "test preview",
    contentSnippet: "test snippet",
    gitBranch: null,
    model: null,
    isSubagent: false,
    parentSessionId: null,
    isTeammate: false,
    teamName: null,
    toolNames: [],
    ...overrides,
  };
}

describe("applySort", () => {
  const metas = [
    makeMeta({ id: "a", timestamp: "2026-01-01T00:00:00Z", messageCount: 10, projectName: "beta" }),
    makeMeta({ id: "b", timestamp: "2026-03-01T00:00:00Z", messageCount: 2, projectName: "alpha" }),
    makeMeta({ id: "c", timestamp: "2026-02-01T00:00:00Z", messageCount: 5, projectName: "gamma" }),
  ];

  it("sorts recent (newest first)", () => {
    const result = applySort(metas, "recent");
    expect(result.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts oldest first", () => {
    const result = applySort(metas, "oldest");
    expect(result.map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts by messages descending", () => {
    const result = applySort(metas, "messages-desc");
    expect(result.map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts by messages ascending", () => {
    const result = applySort(metas, "messages-asc");
    expect(result.map((m) => m.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts alphabetically by projectName", () => {
    const result = applySort(metas, "alpha");
    expect(result.map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate input array", () => {
    const original = [...metas];
    applySort(metas, "recent");
    expect(metas.map((m) => m.id)).toEqual(original.map((m) => m.id));
  });
});

describe("applySinceFilter", () => {
  it("filters by cutoff date", () => {
    const metas = [
      makeMeta({ id: "old", timestamp: "2025-01-01T00:00:00Z" }),
      makeMeta({ id: "new", timestamp: "2026-06-01T00:00:00Z" }),
    ];
    const result = applySinceFilter(metas, "2026-01-01");
    expect(result.map((m) => m.id)).toEqual(["new"]);
  });
});

describe("applyIncludeFilter", () => {
  const metas = [
    makeMeta({ id: "conv", isSubagent: false, isTeammate: false }),
    makeMeta({ id: "sub", isSubagent: true }),
    makeMeta({ id: "team", isTeammate: true }),
  ];

  it('returns all when include is "all"', () => {
    expect(applyIncludeFilter(metas, "all")).toHaveLength(3);
  });

  it("returns only conversations", () => {
    const result = applyIncludeFilter(metas, "conversations");
    expect(result.map((m) => m.id)).toEqual(["conv"]);
  });

  it("returns only subagents", () => {
    const result = applyIncludeFilter(metas, "subagents");
    expect(result.map((m) => m.id)).toEqual(["sub"]);
  });

  it("returns only teammates", () => {
    const result = applyIncludeFilter(metas, "teammates");
    expect(result.map((m) => m.id)).toEqual(["team"]);
  });
});

describe("applyProjectFilter", () => {
  it("filters by project path", () => {
    const metas = [
      makeMeta({ id: "a", projectPath: "/home/user/project-a" }),
      makeMeta({ id: "b", projectPath: "/home/user/project-b" }),
    ];
    const result = applyProjectFilter(metas, "project-a");
    expect(result.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("applyAccountFilter", () => {
  it("filters by account", () => {
    const metas = [
      makeMeta({ id: "a", account: "work" }),
      makeMeta({ id: "b", account: "personal" }),
    ];
    const result = applyAccountFilter(metas, "work");
    expect(result.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("applyPagination", () => {
  const items = [1, 2, 3, 4, 5];

  it("returns first page", () => {
    const result = applyPagination(items, 2, 0);
    expect(result).toEqual({ items: [1, 2], total: 5 });
  });

  it("returns second page", () => {
    const result = applyPagination(items, 2, 2);
    expect(result).toEqual({ items: [3, 4], total: 5 });
  });

  it("returns partial last page", () => {
    const result = applyPagination(items, 2, 4);
    expect(result).toEqual({ items: [5], total: 5 });
  });

  it("returns empty for offset beyond length", () => {
    const result = applyPagination(items, 2, 10);
    expect(result).toEqual({ items: [], total: 5 });
  });
});

describe("parseSinceCutoff", () => {
  it("parses day duration", () => {
    const cutoff = parseSinceCutoff("7d");
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000);
  });

  it("parses hour duration", () => {
    const cutoff = parseSinceCutoff("24h");
    const expected = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000);
  });

  it("parses week duration", () => {
    const cutoff = parseSinceCutoff("2w");
    const expected = Date.now() - 2 * 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(1000);
  });

  it("parses ISO date", () => {
    const cutoff = parseSinceCutoff("2024-01-15");
    expect(cutoff.toISOString().startsWith("2024-01-15")).toBe(true);
  });

  it("throws on invalid format", () => {
    expect(() => parseSinceCutoff("abc")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseSinceCutoff("")).toThrow();
  });
});
