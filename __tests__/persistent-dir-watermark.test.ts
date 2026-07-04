import * as fs from "fs";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as discoveryModule from "../src/discovery";
import { openDatabase } from "../src/persistent/db";
import { ConversationFilesRepo } from "../src/persistent/repositories/conversation-files.repo";
import { ConversationScanner } from "../src/scanner";

function user(sessionId: string, ts: string, text: string) {
  return JSON.stringify({
    type: "user",
    uuid: `u-${sessionId}-${ts}`,
    timestamp: ts,
    sessionId,
    slug: sessionId,
    cwd: `/home/${sessionId}`,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function activePaths(dbPath: string): string[] {
  const db = openDatabase(dbPath);
  const paths = new ConversationFilesRepo(db).allActivePaths();
  db.close();
  return paths;
}

describe("dir-mtime gate in discovery", () => {
  let dir: string;
  let projectsDir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dw-"));
    // getProjectsDir(profile) = join(resolveConfigDir(profile.configDir), "projects")
    projectsDir = join(dir, "config", "projects");
    mkdirSync(projectsDir, { recursive: true });
    dbPath = join(dir, "i.db");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = () => ({
    id: "default",
    label: "T",
    configDir: join(dir, "config"),
    enabled: true,
  });

  function makeProjectDir(name: string): string {
    const p = join(projectsDir, name);
    mkdirSync(p, { recursive: true });
    return p;
  }

  it("skips the glob for a project dir whose mtime is unchanged", async () => {
    const p1 = makeProjectDir("proj-a");
    writeFileSync(join(p1, "s1.jsonl"), `${user("s1", "2026-01-01T00:00:00.000Z", "hello")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();

    const spy = vi.spyOn(discoveryModule, "discoverJsonlFiles");
    const s2 = new ConversationScanner({ persistent: { dbPath } });
    const result = await s2.scan({ profiles: [profile()] });
    s2.close();

    // Nothing changed on disk: neither projectsDir nor proj-a's mtime moved, so
    // the gate must not call the underlying glob for proj-a at all.
    expect(spy).not.toHaveBeenCalled();
    expect(result.conversations).toHaveLength(1);
  });

  it("still indexes an appended file inside an unchanged-mtime project dir", async () => {
    // The gate skips the GLOB for an unchanged dir, but classify() must still
    // run on every already-known file — an append bumps the FILE's mtime, not
    // the directory's, so the gate must never be allowed to hide it.
    const p1 = makeProjectDir("proj-a");
    const file = join(p1, "s1.jsonl");
    writeFileSync(file, `${user("s1", "2026-01-01T00:00:00.000Z", "first")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();

    // Freeze proj-a's directory mtime (simulate "no add/remove happened") while
    // appending to the file inside it.
    const dirStatBefore = fs.statSync(p1);
    fs.appendFileSync(file, `${user("s1", "2026-01-02T00:00:00.000Z", "second")}\n`);
    utimesSync(p1, dirStatBefore.atime, dirStatBefore.mtime);

    const s2 = new ConversationScanner({ persistent: { dbPath } });
    const result = await s2.scan({ profiles: [profile()] });
    s2.close();

    const metas = result.conversations as { sessionId: string; messageCount: number }[];
    expect(metas).toHaveLength(1);
    expect(metas[0].messageCount).toBe(2);
  });

  it("does NOT mark files in a skipped (unchanged-mtime) dir as deleted", async () => {
    // The deletion-reconcile in indexAll marks any active file not returned by
    // discovery as deleted. A file from a skipped dir must still be RETURNED so
    // it lands in that pass's `seen` set — otherwise the gate would mass-delete
    // exactly the conversations it meant to serve faster.
    const p1 = makeProjectDir("proj-a");
    writeFileSync(join(p1, "s1.jsonl"), `${user("s1", "2026-01-01T00:00:00.000Z", "hello")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();

    const before = activePaths(dbPath);
    expect(before).toHaveLength(1);

    // Second scan with nothing changed anywhere — proj-a's mtime is untouched.
    const s2 = new ConversationScanner({ persistent: { dbPath } });
    await s2.scan({ profiles: [profile()] });
    s2.close();

    expect(activePaths(dbPath)).toEqual(before);
  });

  it("globs a project dir whose mtime changed (new file added)", async () => {
    const p1 = makeProjectDir("proj-a");
    writeFileSync(join(p1, "s1.jsonl"), `${user("s1", "2026-01-01T00:00:00.000Z", "hello")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();

    // Adding a new file to proj-a bumps proj-a's own mtime — a real add/remove.
    writeFileSync(
      join(p1, "s2.jsonl"),
      `${user("s2", "2026-01-03T00:00:00.000Z", "new session")}\n`,
    );

    const s2 = new ConversationScanner({ persistent: { dbPath } });
    const result = await s2.scan({ profiles: [profile()] });
    s2.close();

    expect(result.conversations).toHaveLength(2);
  });

  it("globs projectsDir when a new project directory appears", async () => {
    makeProjectDir("proj-a");
    writeFileSync(
      join(projectsDir, "proj-a", "s1.jsonl"),
      `${user("s1", "2026-01-01T00:00:00.000Z", "hello")}\n`,
    );

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();

    // A brand-new project directory bumps projectsDir's own mtime.
    const p2 = makeProjectDir("proj-b");
    writeFileSync(
      join(p2, "s2.jsonl"),
      `${user("s2", "2026-01-04T00:00:00.000Z", "second project")}\n`,
    );

    const s2 = new ConversationScanner({ persistent: { dbPath } });
    const result = await s2.scan({ profiles: [profile()] });
    s2.close();

    expect(result.conversations).toHaveLength(2);
  });

  it("does not commit the root watermark if a project dir fails mid-loop, so the next pass re-lists and recovers", async () => {
    // Crash-window regression: the root watermark must only be committed AFTER
    // every project dir under it has been processed. If it were committed
    // eagerly (e.g. right after readdir), a throw partway through the per-dir
    // loop would leave some project dirs un-globbed with no scanned_dirs row —
    // and the next pass's root-reuse would return only the dirs that DID get a
    // row via childrenOf(), silently dropping the crashed-out dir's files from
    // `seen` and mass-deleting its conversations.
    const p1 = makeProjectDir("proj-a");
    writeFileSync(join(p1, "s1.jsonl"), `${user("s1", "2026-01-01T00:00:00.000Z", "hello")}\n`);
    const p2 = makeProjectDir("proj-b");
    writeFileSync(join(p2, "s2.jsonl"), `${user("s2", "2026-01-01T00:00:00.000Z", "hello2")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();
    expect(activePaths(dbPath)).toHaveLength(2);

    // Force a new project dir so the root watermark is stale and must re-list —
    // then make discoverJsonlFiles (the per-dir glob) throw for proj-c
    // specifically, simulating a crash/IO failure partway through the loop.
    const p3 = makeProjectDir("proj-c");
    writeFileSync(join(p3, "s3.jsonl"), `${user("s3", "2026-01-05T00:00:00.000Z", "hello3")}\n`);

    const realDiscover = discoveryModule.discoverJsonlFiles;
    const spy = vi
      .spyOn(discoveryModule, "discoverJsonlFiles")
      .mockImplementation(async (dirsArg) => {
        if (dirsArg.some((d) => d.projectsDir === p3)) {
          throw new Error("simulated crash indexing proj-c");
        }
        return realDiscover(dirsArg);
      });

    const s2 = new ConversationScanner({ persistent: { dbPath } });
    await expect(s2.scan({ profiles: [profile()] })).rejects.toThrow("simulated crash");
    s2.close();
    spy.mockRestore();

    // The root watermark must NOT have been committed by the failed pass —
    // proj-a/proj-b's data must be untouched (they succeeded before the crash),
    // and proj-c must still be picked up correctly on the very next scan.
    const s3 = new ConversationScanner({ persistent: { dbPath } });
    const result = await s3.scan({ profiles: [profile()] });
    s3.close();

    expect(result.conversations).toHaveLength(3);
    const sessionIds = (result.conversations as { sessionId: string }[])
      .map((m) => m.sessionId)
      .sort();
    expect(sessionIds).toEqual(["s1", "s2", "s3"]);
  });

  it("reconciles a removed file even from a dir the gate would otherwise skip", async () => {
    const p1 = makeProjectDir("proj-a");
    const file = join(p1, "s1.jsonl");
    writeFileSync(file, `${user("s1", "2026-01-01T00:00:00.000Z", "hello")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();

    // Removing the file bumps proj-a's mtime too (directory entry removed), so
    // this is a real "changed" dir, not a gated-skip case — confirms deletion
    // still works through the gate.
    rmSync(file);

    const s2 = new ConversationScanner({ persistent: { dbPath } });
    const result = await s2.scan({ profiles: [profile()] });
    s2.close();

    expect(result.conversations).toHaveLength(0);
    expect(activePaths(dbPath)).toHaveLength(0);
  });

  it("always re-globs a project dir known to have nested files, even with unchanged mtime", async () => {
    const p1 = makeProjectDir("proj-a");
    writeFileSync(join(p1, "s1.jsonl"), `${user("s1", "2026-01-01T00:00:00.000Z", "hello")}\n`);
    const subagents = join(p1, "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, "agent-1.jsonl"),
      `${user("agent-1", "2026-01-01T00:00:00.000Z", "sub hello")}\n`,
    );

    // First scan: proj-a is globbed (new dir), discovers the nested subagent
    // file, and gets marked has_nested since agent-1.jsonl's parent isn't
    // proj-a itself.
    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();

    // Second scan with NOTHING touched anywhere (no utimesSync trickery — a
    // real, naturally unchanged proj-a mtime). If has_nested weren't honored,
    // this would take the reuse fast path and never see the append below.
    // Instead, append to the nested subagent file first, so a working gate
    // must still pick it up despite proj-a's mtime never moving for this write
    // (only subagents/'s mtime moves, which the project-dir-level watermark
    // doesn't track — has_nested is what forces the re-glob here).
    fs.appendFileSync(
      join(subagents, "agent-1.jsonl"),
      `${user("agent-1", "2026-01-02T00:00:00.000Z", "sub second")}\n`,
    );

    const spy = vi.spyOn(discoveryModule, "discoverJsonlFiles");
    const s2 = new ConversationScanner({ persistent: { dbPath } });
    const result = await s2.scan({ profiles: [profile()] });
    s2.close();

    // proj-a is known to have nested files (has_nested), so it must re-glob
    // even though its own mtime never moved for this append — proving the
    // fallback reaches a nested change a project-dir-level watermark alone
    // can't see.
    expect(spy).toHaveBeenCalled();
    const agentMeta = (result.conversations as { sessionId: string; messageCount: number }[]).find(
      (m) => m.sessionId === "agent-1",
    );
    expect(agentMeta?.messageCount).toBe(2);
  });

  it("fullRescan bypasses the gate and re-globs everything", async () => {
    const p1 = makeProjectDir("proj-a");
    writeFileSync(join(p1, "s1.jsonl"), `${user("s1", "2026-01-01T00:00:00.000Z", "hello")}\n`);

    const scanner = new ConversationScanner({ persistent: { dbPath } });
    await scanner.scan({ profiles: [profile()] });
    scanner.close();

    const spy = vi.spyOn(discoveryModule, "discoverJsonlFiles");
    const s2 = new ConversationScanner({ persistent: { dbPath } });
    await s2.scan({ profiles: [profile()], fullRescan: true });
    s2.close();

    expect(spy).toHaveBeenCalled();
  });
});
