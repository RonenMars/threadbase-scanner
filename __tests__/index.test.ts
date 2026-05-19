import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConversationScanner,
  getConversation,
  resetDefaultScanner,
  scan,
  search,
} from "../src/index";
import type { ConversationMeta, Profile } from "../src/types";

const USER_LINE = (uuid: string, ts: string, text: string) =>
  JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    sessionId: "sess-shared",
    slug: "shared-session",
    cwd: "/home/user/project",
    message: { role: "user", content: [{ type: "text", text }] },
  });

const ASSISTANT_LINE = (uuid: string, ts: string, text: string) =>
  JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: ts,
    sessionId: "sess-shared",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text }],
    },
  });

describe("standalone API", () => {
  let tempDir: string;
  let profile: Profile;

  beforeEach(() => {
    resetDefaultScanner();
    tempDir = mkdtempSync(join(tmpdir(), "index-test-"));
    const projectsDir = join(tempDir, "projects");
    mkdirSync(join(projectsDir, "proj"), { recursive: true });
    writeFileSync(
      join(projectsDir, "proj", "session1.jsonl"),
      `${[
        USER_LINE("u1", "2026-03-01T10:00:00.000Z", "alpha keyword"),
        ASSISTANT_LINE("u2", "2026-03-01T10:00:05.000Z", "ok"),
      ].join("\n")}\n`,
    );
    profile = { id: "test", label: "Test", configDir: tempDir, enabled: true };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    resetDefaultScanner();
  });

  it("scan() shares state across calls via the default singleton", async () => {
    const first = await scan({ profiles: [profile] });
    expect(first.total).toBe(1);

    // search() should reuse the indexed state from the previous scan
    const results = await search("alpha", { profiles: [profile] });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("getConversation() hits the LRU on the shared scanner", async () => {
    await scan({ profiles: [profile] });
    const first = await getConversation(join(tempDir, "projects", "proj", "session1.jsonl"));
    expect(first).not.toBeNull();

    // Second call should return the cached instance
    const second = await getConversation(join(tempDir, "projects", "proj", "session1.jsonl"));
    expect(second).toBe(first);
  });

  it("accepts an explicit scanner override", async () => {
    const explicit = new ConversationScanner();
    const result = await scan({ profiles: [profile] }, explicit);
    const convs = result.conversations as ConversationMeta[];
    expect(convs).toHaveLength(1);
    // The explicit scanner should hold the state, not the default singleton.
    expect(explicit.getMetadataCache().size).toBe(1);
  });

  it("resetDefaultScanner() drops shared state", async () => {
    await scan({ profiles: [profile] });
    resetDefaultScanner();
    // After reset, searching without first scanning re-triggers a scan internally.
    const results = await search("alpha", { profiles: [profile] });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
