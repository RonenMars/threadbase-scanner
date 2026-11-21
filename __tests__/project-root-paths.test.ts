import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";
import type { ConversationMeta } from "../src/types";

// projectRoot/worktreePath are also filled on the paths that do not go through
// a Claude scan: a non-Claude provider, refreshFile (a live append), and the
// in-memory page index.
describe("projectRoot and worktreePath on the other fill paths", () => {
  let dir: string;
  let root: string;
  let wt: string;
  let claudeFile: string;
  let codexFile: string;

  const claudeLine = (uuid: string, cwd: string) =>
    `${JSON.stringify({
      type: "user",
      uuid,
      sessionId: "sess-claude",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    })}\n`;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "project-root-paths-")));
    root = join(dir, "repo");
    wt = join(dir, "repo-feature");
    mkdirSync(join(root, ".git", "worktrees", "repo-feature"), { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "repo-feature")}\n`);

    const project = join(dir, "cfg", "projects", "proj");
    mkdirSync(project, { recursive: true });
    claudeFile = join(project, "sess-claude.jsonl");
    writeFileSync(claudeFile, claudeLine("u1", wt));

    // A Codex rollout whose cwd is the worktree.
    mkdirSync(join(dir, "codex"));
    codexFile = join(dir, "codex", "rollout-2026-06-18T17-22-04-sess-basic-0001.jsonl");
    const fixture = readFileSync(
      join(__dirname, "..", "__fixtures__", "codex-cli", "basic-session.jsonl"),
      "utf8",
    );
    writeFileSync(codexFile, fixture.replace("/Users/dev/projects/widget", wt));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const engines: [string, () => ConversationScanner][] = [
    ["in-memory", () => new ConversationScanner({ persistent: false })],
    ["persistent", () => new ConversationScanner({ persistent: { dbPath: join(dir, "p.db") } })],
  ];
  const expected = () => ({ projectRoot: root, worktreePath: wt });

  for (const [name, make] of engines) {
    describe(name, () => {
      it("fills a Codex session", async () => {
        const scanner = make();
        const { conversations } = await scanner.scan({
          profiles: [],
          providers: ["codex-cli"],
          codexRoots: [join(dir, "codex")],
        });
        scanner.close();
        expect((conversations as ConversationMeta[])[0]).toMatchObject(expected());
      });

      it("fills the meta refreshFile returns after an append", async () => {
        const scanner = make();
        const profile = { id: "t", label: "T", configDir: join(dir, "cfg"), enabled: true };
        await scanner.scan({ profiles: [profile] });
        appendFileSync(claudeFile, claudeLine("u2", wt));
        const meta = await scanner.refreshFile(claudeFile);
        scanner.close();
        expect(meta).toMatchObject(expected());
      });
    });
  }

  it("fills the meta of the in-memory page index", async () => {
    const scanner = new ConversationScanner({ persistent: false });
    const profile = { id: "t", label: "T", configDir: join(dir, "cfg"), enabled: true };
    await scanner.scan({ profiles: [profile] });
    const page = await scanner.getConversationPage(claudeFile, { limit: 10 });
    scanner.close();
    expect(page?.meta).toMatchObject(expected());
  });
});
