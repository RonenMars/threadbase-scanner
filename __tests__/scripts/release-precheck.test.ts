import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitsSince,
  lastStableTag,
  loadAnalyzerConfig,
  runPrecheck,
  setOutput,
} from "../../scripts/release-precheck.mjs";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "release-precheck-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  execFileSync("git", ["config", "tag.gpgsign", "false"], { cwd: dir });
  // Match analyzer config shape from the real repo (minimal)
  writeFileSync(
    join(dir, ".releaserc.json"),
    JSON.stringify({
      plugins: [
        [
          "@semantic-release/commit-analyzer",
          {
            preset: "conventionalcommits",
            releaseRules: [
              { type: "feat", release: "minor" },
              { type: "fix", release: "patch" },
            ],
          },
        ],
      ],
    }),
  );
  writeFileSync(join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "chore: init"], { cwd: dir });
  return dir;
}

function tag(cwd: string, name: string) {
  // Always pass -m so annotated-tag configs cannot open an interactive editor.
  execFileSync("git", ["tag", "-a", name, "-m", name], { cwd });
}

describe("scripts/release-precheck", () => {
  let dir: string;

  beforeEach(() => {
    dir = initRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadAnalyzerConfig reads commit-analyzer options", () => {
    const cfg = loadAnalyzerConfig(dir);
    expect(cfg.preset).toBe("conventionalcommits");
  });

  it("lastStableTag ignores prerelease tags", () => {
    tag(dir, "v1.0.0");
    tag(dir, "v1.1.0-next.1");
    writeFileSync(join(dir, "x.txt"), "x");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "fix: something"], { cwd: dir });
    tag(dir, "v1.0.1");
    expect(lastStableTag(dir)).toBe("v1.0.1");
  });

  it("commitsSince returns commits after a tag", () => {
    tag(dir, "v0.1.0");
    writeFileSync(join(dir, "y.txt"), "y");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feat: add y"], { cwd: dir });
    const commits = commitsSince(dir, "v0.1.0");
    expect(commits.length).toBe(1);
    expect(commits[0].message).toMatch(/^feat: add y/);
  });

  it("setOutput appends to GITHUB_OUTPUT file", () => {
    const out = join(dir, "github.out");
    setOutput("should_release", "true", out);
    setOutput("next_version", "1.2.3", out);
    expect(readFileSync(out, "utf8")).toBe("should_release=true\nnext_version=1.2.3\n");
  });

  it("runPrecheck reports a release for feat commits after a stable tag", async () => {
    tag(dir, "v1.0.0");
    writeFileSync(join(dir, "z.txt"), "z");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "feat: add z"], { cwd: dir });

    const outputs: Record<string, string> = {};
    const result = await runPrecheck(dir, {
      setOutput: (k: string, v: string) => {
        outputs[k] = v;
      },
    });
    expect(result.shouldRelease).toBe(true);
    expect(result.releaseType).toBe("minor");
    expect(result.nextVersion).toBe("1.1.0");
    expect(outputs.should_release).toBe("true");
    expect(outputs.next_version).toBe("1.1.0");
  });

  it("runPrecheck reports no release for chore-only commits", async () => {
    tag(dir, "v2.0.0");
    writeFileSync(join(dir, "c.txt"), "c");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "chore: docs only"], { cwd: dir });

    const result = await runPrecheck(dir, {
      setOutput: () => {},
    });
    expect(result.shouldRelease).toBe(false);
    expect(result.nextVersion).toBe("");
  });
});
