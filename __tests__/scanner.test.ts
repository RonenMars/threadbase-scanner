import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
});
