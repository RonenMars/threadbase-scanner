import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";
import type { ConversationMeta, Profile } from "../src/types";

const VALID_LINE = (uuid: string, ts: string, text: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    sessionId: "sess-1",
    slug: "test-session",
    cwd: "/home/user/project",
    message: { role: "user", content: [{ type: "text", text }] },
  });

const ASSISTANT_LINE = (uuid: string, ts: string, text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: ts,
    sessionId: "sess-1",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text }],
    },
  });

describe("ConversationScanner", () => {
  let tempDir: string;
  let profile: Profile;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "scanner-test-"));
    const projectsDir = join(tempDir, "projects");
    mkdirSync(join(projectsDir, "my-project"), { recursive: true });
    writeFileSync(
      join(projectsDir, "my-project", "session1.jsonl"),
      `${[
        VALID_LINE("u1", "2026-01-15T10:00:00.000Z", "Hello"),
        ASSISTANT_LINE("u2", "2026-01-15T10:00:05.000Z", "Hi there"),
      ].join("\n")}\n`,
    );
    writeFileSync(
      join(projectsDir, "my-project", "session2.jsonl"),
      `${[
        VALID_LINE("u3", "2026-02-01T08:00:00.000Z", "Fix the bug"),
        ASSISTANT_LINE("u4", "2026-02-01T08:00:10.000Z", "Done"),
      ].join("\n")}\n`,
    );
    profile = { id: "test", label: "Test", configDir: tempDir, enabled: true };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("scans all conversations", async () => {
    const scanner = new ConversationScanner();
    const result = await scanner.scan({ profiles: [profile] });
    expect(result.conversations).toHaveLength(2);
    expect(result.scanned).toBe(2);
    expect(result.total).toBe(2);
  });

  it("returns conversations sorted by timestamp descending", async () => {
    const scanner = new ConversationScanner();
    const result = await scanner.scan({ profiles: [profile] });
    const convs = result.conversations as ConversationMeta[];
    expect(convs[0].timestamp > convs[1].timestamp).toBe(true);
  });

  it("applies sort option", async () => {
    const scanner = new ConversationScanner();
    const result = await scanner.scan({ profiles: [profile], sort: "oldest" });
    const convs = result.conversations as ConversationMeta[];
    expect(convs[0].timestamp < convs[1].timestamp).toBe(true);
  });

  it("applies pagination", async () => {
    const scanner = new ConversationScanner();
    const result = await scanner.scan({ profiles: [profile], limit: 1, offset: 0 });
    expect(result.conversations).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  it("calls onProgress callback", async () => {
    const scanner = new ConversationScanner();
    const progressCalls: [number, number][] = [];
    await scanner.scan({
      profiles: [profile],
      onProgress: (scanned, total) => progressCalls.push([scanned, total]),
    });
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it("calls onBatch callback", async () => {
    const scanner = new ConversationScanner();
    let batchCount = 0;
    await scanner.scan({
      profiles: [profile],
      onBatch: () => {
        batchCount++;
      },
    });
    expect(batchCount).toBeGreaterThan(0);
  });

  it("loads a full conversation by id", async () => {
    const scanner = new ConversationScanner();
    await scanner.scan({ profiles: [profile] });

    const metas = scanner.getMetadataCache();
    const firstId = Array.from(metas.keys())[0];
    const conv = await scanner.getConversation(firstId);

    expect(conv).not.toBeNull();
    expect(conv?.messages.length).toBeGreaterThan(0);
  });

  it("searches indexed conversations", async () => {
    const scanner = new ConversationScanner();
    const results = await scanner.search("Hello", { profiles: [profile] });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("skips disabled profiles", async () => {
    const disabledProfile = { ...profile, enabled: false };
    const scanner = new ConversationScanner();
    const result = await scanner.scan({ profiles: [disabledProfile] });
    expect(result.conversations).toHaveLength(0);
  });

  it("skips profiles with scanHistory=false", async () => {
    const noScanProfile = { ...profile, scanHistory: false };
    const scanner = new ConversationScanner();
    const result = await scanner.scan({ profiles: [noScanProfile] });
    expect(result.conversations).toHaveLength(0);
  });

  describe("getConversationPage", () => {
    // The paged fixture mixes plain user/assistant text with thinking blocks
    // and tool_use/tool_result pairs, so windowed indices must line up with the
    // full parse's line→message reduction. sessionId is "sess-page".
    const PAGED_SESSION = "sess-page";
    const FIXTURE = join(__dirname, "..", "__fixtures__", "paged-conversation.jsonl");

    beforeEach(() => {
      copyFileSync(FIXTURE, join(tempDir, "projects", "my-project", "paged.jsonl"));
    });

    it("returns the newest page when beforeIndex is omitted", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });

      const full = await scanner.getConversation(PAGED_SESSION);
      const total = full?.messages.length ?? 0;
      expect(total).toBeGreaterThan(10);

      const page = await scanner.getConversationPage(PAGED_SESSION, { limit: 10 });
      expect(page).not.toBeNull();
      expect(page?.total).toBe(total);
      expect(page?.fromIndex).toBe(total - 10);
      expect(page?.messages).toHaveLength(10);
      expect(page?.messages).toEqual(full?.messages.slice(total - 10, total));
    });

    it("scrolls back a page using the previous fromIndex", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });

      const full = await scanner.getConversation(PAGED_SESSION);
      const total = full?.messages.length ?? 0;

      const newest = await scanner.getConversationPage(PAGED_SESSION, { limit: 10 });
      const back = await scanner.getConversationPage(PAGED_SESSION, {
        beforeIndex: newest?.fromIndex,
        limit: 10,
      });

      expect(back?.fromIndex).toBe(total - 20);
      expect(back?.messages).toHaveLength(10);
      expect(back?.messages).toEqual(full?.messages.slice(total - 20, total - 10));
    });

    it("clamps the first page to index 0 when beforeIndex <= limit", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });

      const full = await scanner.getConversation(PAGED_SESSION);

      const page = await scanner.getConversationPage(PAGED_SESSION, { beforeIndex: 6, limit: 10 });
      expect(page?.fromIndex).toBe(0);
      expect(page?.messages).toHaveLength(6);
      expect(page?.messages).toEqual(full?.messages.slice(0, 6));
    });

    it("matches the corresponding slice of a full parse for several windows", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });

      const full = await scanner.getConversation(PAGED_SESSION);
      const total = full?.messages.length ?? 0;

      const windows: Array<{ beforeIndex?: number; limit: number }> = [
        { limit: 10 },
        { beforeIndex: total, limit: 5 },
        { beforeIndex: 6, limit: 6 }, // boundary across thinking/tool blocks
        { beforeIndex: 4, limit: 10 }, // clamps to 0
        { beforeIndex: 20, limit: 7 },
        { beforeIndex: 0, limit: 10 }, // empty window
      ];

      for (const opts of windows) {
        const page = await scanner.getConversationPage(PAGED_SESSION, opts);
        const beforeIndex = opts.beforeIndex ?? total;
        const expectedFrom = Math.max(0, beforeIndex - opts.limit);
        expect(page?.fromIndex).toBe(expectedFrom);
        expect(page?.total).toBe(total);
        expect(page?.messages).toEqual(full?.messages.slice(expectedFrom, beforeIndex));
      }
    });

    it("returns null for an unknown id", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });
      const page = await scanner.getConversationPage("does-not-exist", { limit: 10 });
      expect(page).toBeNull();
    });
  });

  describe("parseSingleFilePage", () => {
    const PAGED_SESSION = "sess-page";
    const FIXTURE = join(__dirname, "..", "__fixtures__", "paged-conversation.jsonl");

    it("parses a single file and slices a page without any prior scan", async () => {
      // No scan(): parseSingleFilePage works straight off the file path. This
      // is the cold-start fast path.
      const scanner = new ConversationScanner();

      // Reference: the same file fully parsed via a scanned scanner.
      const scanned = new ConversationScanner();
      copyFileSync(FIXTURE, join(tempDir, "projects", "my-project", "paged.jsonl"));
      await scanned.scan({ profiles: [profile] });
      const full = await scanned.getConversation(PAGED_SESSION);
      const total = full?.messages.length ?? 0;
      expect(total).toBeGreaterThan(10);

      const page = await scanner.parseSingleFilePage(FIXTURE, "default", { limit: 10 });
      expect(page).not.toBeNull();
      expect(page?.total).toBe(total);
      expect(page?.fromIndex).toBe(total - 10);
      expect(page?.messages).toHaveLength(10);
      expect(page?.messages).toEqual(full?.messages.slice(total - 10, total));
      // The parsed conversation is returned alongside the window.
      expect(page?.conversation.messages).toHaveLength(total);
    });

    it("matches a full parse for several windows", async () => {
      const scanner = new ConversationScanner();
      const ref = await scanner.parseSingleFilePage(FIXTURE, "default", { limit: 100000 });
      const total = ref?.total ?? 0;
      const all = ref?.conversation.messages ?? [];

      const windows: Array<{ beforeIndex?: number; limit: number }> = [
        { limit: 10 },
        { beforeIndex: total, limit: 5 },
        { beforeIndex: 6, limit: 6 },
        { beforeIndex: 4, limit: 10 },
        { beforeIndex: 0, limit: 10 },
      ];

      for (const opts of windows) {
        const page = await scanner.parseSingleFilePage(FIXTURE, "default", opts);
        const beforeIndex = opts.beforeIndex ?? total;
        const expectedFrom = Math.max(0, beforeIndex - opts.limit);
        expect(page?.fromIndex).toBe(expectedFrom);
        expect(page?.total).toBe(total);
        expect(page?.messages).toEqual(all.slice(expectedFrom, beforeIndex));
      }
    });

    it("returns null for a missing file", async () => {
      const scanner = new ConversationScanner();
      const page = await scanner.parseSingleFilePage(
        join(tempDir, "does-not-exist.jsonl"),
        "default",
        { limit: 10 },
      );
      expect(page).toBeNull();
    });
  });

  describe("refreshFile", () => {
    const filePath = () => join(tempDir, "projects", "my-project", "session1.jsonl");

    it("picks up messages appended after the initial scan", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });

      const before = await scanner.getConversation("sess-1");
      expect(before?.messageCount).toBe(2);

      writeFileSync(
        filePath(),
        `${[
          VALID_LINE("u1", "2026-01-15T10:00:00.000Z", "Hello"),
          ASSISTANT_LINE("u2", "2026-01-15T10:00:05.000Z", "Hi there"),
          VALID_LINE("u5", "2026-01-16T09:00:00.000Z", "One more thing"),
          ASSISTANT_LINE("u6", "2026-01-16T09:00:05.000Z", "the real latest message"),
        ].join("\n")}\n`,
      );

      const meta = await scanner.refreshFile(filePath());
      expect(meta?.messageCount).toBe(4);

      // The stale parsed conversation must be evicted so the next read re-parses.
      const after = await scanner.getConversation("sess-1");
      expect(after?.messageCount).toBe(4);
      expect(after?.messages.at(-1)?.text).toContain("the real latest message");
    });

    it("keeps the search index in sync with the refreshed content", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });

      writeFileSync(
        filePath(),
        `${[
          VALID_LINE("u1", "2026-01-15T10:00:00.000Z", "supercalifragilistic"),
          ASSISTANT_LINE("u2", "2026-01-15T10:00:05.000Z", "indexed reply"),
        ].join("\n")}\n`,
      );
      await scanner.refreshFile(filePath());

      const results = await scanner.search("supercalifragilistic");
      expect(results.some((r) => r.meta.sessionId === "sess-1")).toBe(true);
    });

    it("returns null and drops the entry when the file no longer parses", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });
      // metadataCache is keyed by meta.id, which the parser sets to the file path.
      expect(scanner.getMetadataCache().has(filePath())).toBe(true);

      // Empty the file so parseMeta yields no messages.
      writeFileSync(filePath(), "");
      const meta = await scanner.refreshFile(filePath());

      expect(meta).toBeNull();
      expect(scanner.getMetadataCache().has(filePath())).toBe(false);
      expect(await scanner.getConversation("sess-1")).toBeNull();
    });

    it("returns null for a path that was never scanned", async () => {
      const scanner = new ConversationScanner();
      await scanner.scan({ profiles: [profile] });
      const meta = await scanner.refreshFile(join(tempDir, "projects", "nope", "ghost.jsonl"));
      expect(meta).toBeNull();
    });
  });
});
