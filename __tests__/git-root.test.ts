import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectRoot } from "../src/git";

describe("readProjectRoot", () => {
  let dir: string;
  let root: string; // main checkout: .git is a directory
  let wt: string; // linked worktree: .git is a file
  let submodule: string;

  beforeEach(() => {
    // realpath: a real `git worktree add` records the resolved path, and macOS's
    // tmpdir is a symlink.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "git-root-")));
    root = join(dir, "apps", "Tabby");
    wt = join(dir, "apps", "Tabby-audio");
    submodule = join(dir, "apps", "Tabby-sub");
    mkdirSync(join(root, ".git", "worktrees", "Tabby-audio"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    mkdirSync(submodule, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "Tabby-audio")}\n`);
    writeFileSync(join(submodule, ".git"), `gitdir: ${join(root, ".git", "modules", "sub")}\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a main checkout is its own root and not a worktree", () => {
    expect(readProjectRoot(root)).toEqual({ projectRoot: root, worktreePath: null });
  });

  it("a linked worktree resolves to the main checkout and records its own path", () => {
    expect(readProjectRoot(wt)).toEqual({ projectRoot: root, worktreePath: wt });
  });

  it("resolves a relative gitdir against the worktree", () => {
    writeFileSync(join(wt, ".git"), "gitdir: ../Tabby/.git/worktrees/Tabby-audio\n");
    expect(readProjectRoot(wt)).toEqual({ projectRoot: root, worktreePath: wt });
  });

  it("ignores a trailing slash", () => {
    expect(readProjectRoot(`${wt}/`)).toEqual({ projectRoot: root, worktreePath: wt });
    expect(readProjectRoot(`${root}/`)).toEqual({ projectRoot: root, worktreePath: null });
  });

  it("a submodule is its own project", () => {
    expect(readProjectRoot(submodule)).toEqual({ projectRoot: submodule, worktreePath: null });
  });

  it("a .git file that is not a gitdir pointer is its own project", () => {
    writeFileSync(join(wt, ".git"), "garbage\n");
    expect(readProjectRoot(wt)).toEqual({ projectRoot: wt, worktreePath: null });
  });

  it("a missing path, a directory with no .git, and an empty path resolve to null", () => {
    expect(readProjectRoot(join(dir, "gone"))).toBeNull();
    expect(readProjectRoot(dir)).toBeNull();
    expect(readProjectRoot("")).toBeNull();
  });

  it("does not walk up: a subdirectory of a checkout resolves to null", () => {
    const sub = join(root, "src");
    mkdirSync(sub);
    expect(readProjectRoot(sub)).toBeNull();
  });

  it("agrees with a real `git worktree add` on the installed git", () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd, stdio: "pipe" },
      );
    const main = join(dir, "real-main");
    const linked = join(dir, "real-linked");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", linked, "-b", "wt-branch");

    expect(readProjectRoot(main)).toEqual({ projectRoot: main, worktreePath: null });
    expect(readProjectRoot(linked)).toEqual({ projectRoot: main, worktreePath: linked });
  });
});
