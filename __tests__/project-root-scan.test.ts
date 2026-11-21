import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as git from "../src/git";
import { ConversationScanner } from "../src/scanner";
import type { ConversationMeta, Profile } from "../src/types";

// A repo and its linked worktree have different cwds, so they scan as two
// projects. projectRoot lets a host group them; worktreePath says which one is
// the linked checkout. Filled in both the in-memory and the persistent engine.
describe("scan: projectRoot and worktreePath", () => {
  let dir: string;
  let root: string;
  let wt: string;
  let plain: string;
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
    dir = realpathSync(mkdtempSync(join(tmpdir(), "project-root-scan-")));
    root = join(dir, "repo");
    wt = join(dir, "repo-feature");
    plain = join(dir, "not-a-repo");
    mkdirSync(join(root, ".git", "worktrees", "repo-feature"), { recursive: true });
    mkdirSync(wt);
    mkdirSync(plain);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "repo-feature")}\n`);

    const projects = join(dir, "cfg", "projects", "proj");
    mkdirSync(projects, { recursive: true });
    const files: [string, string][] = [
      ["main-1", root],
      ["main-2", root],
      ["wt-1", wt],
      ["plain-1", plain],
    ];
    files.forEach(([id, cwd], i) => {
      writeFileSync(
        join(projects, `${id}.jsonl`),
        `${LINE(id, `2026-01-0${i + 1}T00:00:00.000Z`, cwd)}\n`,
      );
    });
    profile = { id: "test", label: "Test", configDir: join(dir, "cfg"), enabled: true };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const engines: [string, () => ConversationScanner][] = [
    ["in-memory", () => new ConversationScanner({ persistent: false })],
    ["persistent", () => new ConversationScanner({ persistent: { dbPath: join(dir, "p.db") } })],
  ];

  const byId = async (scanner: ConversationScanner) => {
    const { conversations } = await scanner.scan({ profiles: [profile] });
    return new Map((conversations as ConversationMeta[]).map((c) => [c.sessionId, c]));
  };

  for (const [name, make] of engines) {
    describe(name, () => {
      it("gives a repo and its worktree the same root; only the worktree has a worktreePath", async () => {
        const scanner = make();
        const metas = await byId(scanner);
        scanner.close();

        expect(metas.get("main-1")).toMatchObject({ projectRoot: root, worktreePath: null });
        expect(metas.get("wt-1")).toMatchObject({ projectRoot: root, worktreePath: wt });
      });

      it("leaves both fields unset when the project path has no .git", async () => {
        const scanner = make();
        const metas = await byId(scanner);
        scanner.close();

        const meta = metas.get("plain-1") as ConversationMeta;
        expect(meta.projectRoot).toBeUndefined();
        expect(meta.worktreePath).toBeUndefined();
      });

      it("resolves once per distinct project path, not once per file", async () => {
        const spy = vi.spyOn(git, "readProjectRoot");
        const scanner = make();
        await byId(scanner);
        scanner.close();

        // 4 files across 3 distinct cwds.
        expect(spy.mock.calls.length).toBe(3);
      });
    });
  }

  it("persistent rows keep the fields across a restart (read back from SQLite)", async () => {
    const first = engines[1][1]();
    await byId(first);
    first.close();

    // Files are unchanged, so the second scanner serves the stored rows.
    const second = engines[1][1]();
    const { conversations } = await second.scan({ profiles: [profile] });
    second.close();
    const wtMeta = (conversations as ConversationMeta[]).find((c) => c.sessionId === "wt-1");
    expect(wtMeta).toMatchObject({ projectRoot: root, worktreePath: wt });
  });
});
