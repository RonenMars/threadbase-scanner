import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as git from "../src/git";
import { ConversationScanner } from "../src/scanner";
import type { Profile } from "../src/types";

// A scan calls readGitBranch once per conversation in the source loop, but the
// scanner memoizes per project path for the duration of one scan(). With many
// files sharing a project root, readGitBranch must run once per distinct
// project path, not once per file — and still return the correct branch.
describe("scan: git-branch memoization", () => {
  let tempDir: string;
  let profile: Profile;

  const LINE = (uuid: string, ts: string, cwd: string) =>
    JSON.stringify({
      type: "user",
      uuid,
      timestamp: ts,
      sessionId: uuid,
      cwd,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "git-memo-test-"));
    const projectsDir = join(tempDir, "projects", "proj");
    mkdirSync(projectsDir, { recursive: true });
    // Three conversations sharing one cwd (one project root), one in a second.
    writeFileSync(
      join(projectsDir, "a.jsonl"),
      `${LINE("a", "2026-01-01T00:00:00.000Z", "/repo/one")}\n`,
    );
    writeFileSync(
      join(projectsDir, "b.jsonl"),
      `${LINE("b", "2026-01-02T00:00:00.000Z", "/repo/one")}\n`,
    );
    writeFileSync(
      join(projectsDir, "c.jsonl"),
      `${LINE("c", "2026-01-03T00:00:00.000Z", "/repo/one")}\n`,
    );
    writeFileSync(
      join(projectsDir, "d.jsonl"),
      `${LINE("d", "2026-01-04T00:00:00.000Z", "/repo/two")}\n`,
    );
    profile = { id: "test", label: "Test", configDir: tempDir, enabled: true };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("calls readGitBranch once per distinct project path, not per file", async () => {
    const spy = vi
      .spyOn(git, "readGitBranch")
      .mockImplementation((p: string) => (p === "/repo/one" ? "main" : "dev"));

    const scanner = new ConversationScanner();
    const result = await scanner.scan({ profiles: [profile] });

    // 4 files, 2 distinct project paths → at most 2 underlying calls.
    const calledPaths = spy.mock.calls.map((c) => c[0]);
    expect(new Set(calledPaths).size).toBe(2);
    expect(spy.mock.calls.length).toBe(2);

    // …and the branch value is applied correctly to every conversation.
    const metas = [...scanner.getMetadataCache().values()];
    expect(metas).toHaveLength(4);
    for (const m of metas) {
      expect(m.gitBranch).toBe(m.projectPath === "/repo/one" ? "main" : "dev");
    }
    expect(result.scanned).toBe(4);
  });
});
