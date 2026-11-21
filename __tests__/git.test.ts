import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
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

  describe("a linked worktree (.git is a file)", () => {
    // The worktree's HEAD lives under <root>/.git/worktrees/<name>, not in the
    // worktree directory, so a walk up for .git/HEAD finds nothing (or, worse,
    // a parent checkout's branch).
    const setup = (gitdirLine: (admin: string) => string) => {
      const admin = join(tempDir, "root", ".git", "worktrees", "feat");
      const wt = join(tempDir, "root-feat");
      mkdirSync(admin, { recursive: true });
      mkdirSync(wt);
      writeFileSync(join(admin, "HEAD"), "ref: refs/heads/fix/ios-barcode\n");
      writeFileSync(join(wt, ".git"), `${gitdirLine(admin)}\n`);
      return wt;
    };

    it("reads the branch through an absolute gitdir", () => {
      expect(readGitBranch(setup((admin) => `gitdir: ${admin}`))).toBe("fix/ios-barcode");
    });

    it("reads the branch through a relative gitdir", () => {
      expect(readGitBranch(setup(() => "gitdir: ../root/.git/worktrees/feat"))).toBe(
        "fix/ios-barcode",
      );
    });

    it("reports a detached worktree HEAD", () => {
      const wt = setup((admin) => `gitdir: ${admin}`);
      writeFileSync(
        join(tempDir, "root", ".git", "worktrees", "feat", "HEAD"),
        "abc1234def5678901234567890abcdef12345678\n",
      );
      expect(readGitBranch(wt)).toBe("(detached)");
    });

    it("agrees with `git branch --show-current` on a real worktree", () => {
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
          { cwd, stdio: "pipe", encoding: "utf-8" },
        );
      const main = join(realpathSync(tempDir), "real-main");
      const linked = join(realpathSync(tempDir), "real-linked");
      mkdirSync(main);
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "init");
      git(main, "worktree", "add", "-q", linked, "-b", "wt-branch");
      expect(readGitBranch(linked)).toBe("wt-branch");
    });
  });
});
