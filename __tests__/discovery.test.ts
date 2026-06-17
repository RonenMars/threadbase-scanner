import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverJsonlFiles } from "../src/discovery";

describe("discoverJsonlFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "discovery-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createFile(relativePath: string, content = '{"type":"user"}\n') {
    const fullPath = join(tempDir, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }

  it("finds .jsonl files", async () => {
    createFile("project/session.jsonl");
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: "default" }]);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toContain("session.jsonl");
    expect(result[0].account).toBe("default");
  });

  it("finds nested .jsonl files (recursive)", async () => {
    createFile("project/uuid1/session.jsonl");
    createFile("project/uuid1/subagents/agent.jsonl");
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: "default" }]);
    expect(result).toHaveLength(2);
  });

  it("skips empty files", async () => {
    createFile("project/empty.jsonl", "");
    createFile("project/nonempty.jsonl", '{"type":"user"}\n');
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: "default" }]);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toContain("nonempty.jsonl");
  });

  it("skips memory/ directories", async () => {
    createFile("project/memory/notes.jsonl");
    createFile("project/session.jsonl");
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: "default" }]);
    expect(result).toHaveLength(1);
  });

  it("skips tool-results/ directories", async () => {
    createFile("project/tool-results/output.jsonl");
    createFile("project/session.jsonl");
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: "default" }]);
    expect(result).toHaveLength(1);
  });

  it("does NOT skip subagents/ directories", async () => {
    createFile("project/uuid/subagents/agent.jsonl");
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: "default" }]);
    expect(result).toHaveLength(1);
  });

  it("handles non-existent directory gracefully", async () => {
    const result = await discoverJsonlFiles([
      { projectsDir: "/nonexistent/path", account: "default" },
    ]);
    expect(result).toEqual([]);
  });

  it("scans multiple directories", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "discovery-test2-"));
    createFile("project/a.jsonl");
    mkdirSync(join(dir2, "project"), { recursive: true });
    writeFileSync(join(dir2, "project", "b.jsonl"), '{"type":"user"}\n');

    const result = await discoverJsonlFiles([
      { projectsDir: tempDir, account: "account1" },
      { projectsDir: dir2, account: "account2" },
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.account === "account1")).toBeDefined();
    expect(result.find((r) => r.account === "account2")).toBeDefined();

    rmSync(dir2, { recursive: true, force: true });
  });

  it("discovers all non-empty files when count exceeds the stat concurrency cap", async () => {
    // More files than STAT_CONCURRENCY (32) to exercise multiple chunks; one
    // empty file mixed in to confirm filtering still holds under concurrency.
    const total = 70;
    for (let i = 0; i < total; i++) {
      createFile(`project/s${i}.jsonl`, i === 0 ? "" : '{"type":"user"}\n');
    }
    const result = await discoverJsonlFiles([{ projectsDir: tempDir, account: "default" }]);
    expect(result).toHaveLength(total - 1);
    const names = new Set(result.map((r) => r.filePath));
    for (let i = 1; i < total; i++) {
      expect([...names].some((n) => n.endsWith(`s${i}.jsonl`))).toBe(true);
    }
  });
});
