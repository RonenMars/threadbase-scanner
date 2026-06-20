import { describe, expect, it } from "vitest";
import { type IndexJob, IndexQueue } from "../src/watcher/index-queue";

const job = (filePath: string): IndexJob => ({ filePath, account: "default", reason: "watcher" });

describe("IndexQueue", () => {
  it("processes enqueued jobs and resolves onIdle when drained", async () => {
    const processed: string[] = [];
    const q = new IndexQueue(async (j) => {
      processed.push(j.filePath);
    });
    q.enqueue(job("a"));
    q.enqueue(job("b"));
    await q.onIdle();
    expect(processed.sort()).toEqual(["a", "b"]);
  });

  it("deduplicates by path — the latest job for a path wins", async () => {
    const seen: IndexJob[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const q = new IndexQueue(async (j) => {
      // Block on the first job so the next two enqueues for "x" collapse.
      if (j.filePath === "first") await gate;
      seen.push(j);
    });

    q.enqueue(job("first"));
    q.enqueue({ ...job("x"), reason: "watcher" });
    q.enqueue({ ...job("x"), reason: "manual" }); // supersedes the prior "x"
    release();
    await q.onIdle();

    const xJobs = seen.filter((j) => j.filePath === "x");
    expect(xJobs).toHaveLength(1);
    expect(xJobs[0].reason).toBe("manual");
  });

  it("runs jobs one at a time (single writer)", async () => {
    let active = 0;
    let maxActive = 0;
    const q = new IndexQueue(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    for (let i = 0; i < 5; i++) q.enqueue(job(`f${i}`));
    await q.onIdle();
    expect(maxActive).toBe(1);
  });

  it("keeps draining after a job throws", async () => {
    const processed: string[] = [];
    const q = new IndexQueue(async (j) => {
      if (j.filePath === "boom") throw new Error("kaboom");
      processed.push(j.filePath);
    });
    q.enqueue(job("boom"));
    q.enqueue(job("ok"));
    await q.onIdle();
    expect(processed).toEqual(["ok"]);
  });
});
