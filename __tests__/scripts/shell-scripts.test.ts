import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";

const ROOT = join(__dirname, "../..");
const CAPTURE = join(ROOT, "scripts/capture-live.sh");
const UPDATE = join(ROOT, "scripts/update-baseline.sh");

describe("scripts/capture-live.sh + update-baseline.sh", () => {
  it("bash -n passes for both shell scripts", () => {
    for (const script of [CAPTURE, UPDATE]) {
      const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    }
  });

  it("capture-live copies the newest jsonl into baseline-live.jsonl with mocks", () => {
    const home = mkdtempSync(join(tmpdir(), "capture-home-"));
    const bin = mkdtempSync(join(tmpdir(), "capture-bin-"));
    const fixtures = mkdtempSync(join(tmpdir(), "capture-fix-"));
    const projects = join(home, ".claude/projects/demo");
    mkdirSync(projects, { recursive: true });

    const jsonl = join(projects, "session.jsonl");
    writeFileSync(jsonl, '{"type":"user","message":{"content":"hi"}}\n');

    // Fake claude: succeed and leave the jsonl alone (already present)
    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\nexit 0\n");
    chmodSync(claude, 0o755);

    // Fake validate-live via npx tsx path: override by wrapping PATH and
    // providing a no-op tsx + script isn't easy; instead stub `npx`.
    const npx = join(bin, "npx");
    writeFileSync(npx, "#!/bin/sh\nexit 0\n");
    chmodSync(npx, 0o755);

    // Point the script's FIXTURES_DIR by running from a wrapper that sets SCRIPT_DIR tricks —
    // capture-live derives FIXTURES_DIR from its own location. Copy scripts into a temp tree.
    const tree = mkdtempSync(join(tmpdir(), "capture-tree-"));
    mkdirSync(join(tree, "scripts"), { recursive: true });
    mkdirSync(join(tree, "__fixtures__"), { recursive: true });
    execFileSync("cp", [CAPTURE, join(tree, "scripts/capture-live.sh")]);
    writeFileSync(join(tree, "scripts/validate-live.ts"), "export {};\n");

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

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const baseline = join(tree, "__fixtures__/baseline-live.jsonl");
    expect(readFileSync(baseline, "utf8")).toContain('"type":"user"');

    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });

  it("update-baseline saves previous baseline then re-captures", () => {
    const home = mkdtempSync(join(tmpdir(), "update-home-"));
    const bin = mkdtempSync(join(tmpdir(), "update-bin-"));
    const tree = mkdtempSync(join(tmpdir(), "update-tree-"));
    mkdirSync(join(tree, "scripts"), { recursive: true });
    mkdirSync(join(tree, "__fixtures__"), { recursive: true });

    writeFileSync(join(tree, "__fixtures__/baseline-live.jsonl"), '{"old":true}\n');
    execFileSync("cp", [CAPTURE, join(tree, "scripts/capture-live.sh")]);
    execFileSync("cp", [UPDATE, join(tree, "scripts/update-baseline.sh")]);
    writeFileSync(join(tree, "scripts/validate-live.ts"), "export {};\n");

    const projects = join(home, ".claude/projects/demo");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "session.jsonl"), '{"new":true}\n');

    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\nexit 0\n");
    chmodSync(claude, 0o755);
    const npx = join(bin, "npx");
    writeFileSync(npx, "#!/bin/sh\nexit 0\n");
    chmodSync(npx, 0o755);

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
    const bin = mkdtempSync(join(tmpdir(), "capture-bin-empty-"));
    const tree = mkdtempSync(join(tmpdir(), "capture-tree-empty-"));
    mkdirSync(join(tree, "scripts"), { recursive: true });
    mkdirSync(join(tree, "__fixtures__"), { recursive: true });
    mkdirSync(join(home, ".claude/projects"), { recursive: true });
    execFileSync("cp", [CAPTURE, join(tree, "scripts/capture-live.sh")]);

    const claude = join(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\nexit 0\n");
    chmodSync(claude, 0o755);

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
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/No JSONL file found/);

    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });
});
