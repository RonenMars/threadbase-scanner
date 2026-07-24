import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";

const ROOT = join(__dirname, "../..");
const SCRIPTS = join(ROOT, "scripts");
const CAPTURE = join(SCRIPTS, "capture-live.sh");
const UPDATE = join(SCRIPTS, "update-baseline.sh");
const LIB = join(SCRIPTS, "lib");

function stageScriptTree(): string {
  const tree = mkdtempSync(join(tmpdir(), "scripts-tree-"));
  mkdirSync(join(tree, "scripts/lib"), { recursive: true });
  mkdirSync(join(tree, "__fixtures__"), { recursive: true });
  execFileSync("cp", [CAPTURE, join(tree, "scripts/capture-live.sh")]);
  execFileSync("cp", [UPDATE, join(tree, "scripts/update-baseline.sh")]);
  execFileSync("cp", ["-R", LIB, join(tree, "scripts")]);
  writeFileSync(join(tree, "scripts/validate-live.ts"), "export {};\n");
  return tree;
}

function fakeBin(): { bin: string; claude: string } {
  const bin = mkdtempSync(join(tmpdir(), "scripts-bin-"));
  const claude = join(bin, "claude");
  writeFileSync(claude, "#!/bin/sh\nexit 0\n");
  chmodSync(claude, 0o755);
  const npx = join(bin, "npx");
  writeFileSync(npx, "#!/bin/sh\nexit 0\n");
  chmodSync(npx, 0o755);
  return { bin, claude };
}

describe("scripts/capture-live.sh + update-baseline.sh", () => {
  it("bash -n passes for shell scripts and lib helpers", () => {
    for (const script of [CAPTURE, UPDATE, join(LIB, "log.sh"), join(LIB, "baseline-paths.sh")]) {
      const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    }
  });

  it("capture-live copies the newest jsonl and emits step logs", () => {
    const home = mkdtempSync(join(tmpdir(), "capture-home-"));
    const { bin, claude } = fakeBin();
    const projects = join(home, ".claude/projects/demo");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "session.jsonl"), '{"type":"user","message":{"content":"hi"}}\n');

    const tree = stageScriptTree();
    const r = spawnSync("bash", [join(tree, "scripts/capture-live.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_BIN: claude,
        CLAUDE_PROJECTS_DIR: join(home, ".claude/projects"),
      },
    });

    const err = r.stderr;
    expect(r.status, `${r.stdout}\n${err}`).toBe(0);
    expect(err).toMatch(/\[capture-live\] step=init/);
    expect(err).toMatch(/\[capture-live\] step=claude-run/);
    expect(err).toMatch(/\[capture-live\] step=save-baseline/);
    expect(err).toMatch(/\[capture-live\] step=done ok/);
    expect(readFileSync(join(tree, "__fixtures__/baseline-live.jsonl"), "utf8")).toContain(
      '"type":"user"',
    );

    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });

  it("update-baseline saves previous baseline then re-captures", () => {
    const home = mkdtempSync(join(tmpdir(), "update-home-"));
    const { bin, claude } = fakeBin();
    const tree = stageScriptTree();
    writeFileSync(join(tree, "__fixtures__/baseline-live.jsonl"), '{"old":true}\n');

    const projects = join(home, ".claude/projects/demo");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "session.jsonl"), '{"new":true}\n');

    const r = spawnSync("bash", [join(tree, "scripts/update-baseline.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_BIN: claude,
        CLAUDE_PROJECTS_DIR: join(home, ".claude/projects"),
      },
    });

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/\[update-baseline\] step=save-prev/);
    expect(r.stderr).toMatch(/\[update-baseline\] step=capture-live/);
    expect(r.stderr).toMatch(/\[update-baseline\] step=done ok/);
    expect(readFileSync(join(tree, "__fixtures__/baseline-live.prev.jsonl"), "utf8")).toContain(
      '"old":true',
    );
    expect(readFileSync(join(tree, "__fixtures__/baseline-live.jsonl"), "utf8")).toContain(
      '"new":true',
    );

    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });

  it("capture-live errors when no jsonl exists", () => {
    const home = mkdtempSync(join(tmpdir(), "capture-empty-"));
    const { bin, claude } = fakeBin();
    const tree = stageScriptTree();
    mkdirSync(join(home, ".claude/projects"), { recursive: true });

    const r = spawnSync("bash", [join(tree, "scripts/capture-live.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_BIN: claude,
        CLAUDE_PROJECTS_DIR: join(home, ".claude/projects"),
      },
    });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/FAIL step=find-latest-jsonl/);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/No JSONL file found/);

    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });
});
