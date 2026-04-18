import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitBranch } from "../src/git";

describe("readGitBranch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "git-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns branch name from .git/HEAD", () => {
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(readGitBranch(tempDir)).toBe("main");
  });

  it("returns feature branch name", () => {
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "HEAD"), "ref: refs/heads/feature/my-branch\n");
    expect(readGitBranch(tempDir)).toBe("feature/my-branch");
  });

  it("returns (detached) for commit hash", () => {
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "HEAD"), "abc1234def5678901234567890abcdef12345678\n");
    expect(readGitBranch(tempDir)).toBe("(detached)");
  });

  it("walks up directories to find .git", () => {
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    writeFileSync(join(tempDir, ".git", "HEAD"), "ref: refs/heads/develop\n");
    const subDir = join(tempDir, "src", "deep");
    mkdirSync(subDir, { recursive: true });
    expect(readGitBranch(subDir)).toBe("develop");
  });

  it("returns null if no .git found within depth", () => {
    // No .git created — tempDir is clean
    expect(readGitBranch(tempDir)).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(readGitBranch("")).toBeNull();
  });
});
