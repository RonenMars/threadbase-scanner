import { getLogger } from "../logger";

export type JobReason = "watcher" | "manual" | "periodic";

export interface IndexJob {
  filePath: string;
  account: string;
  reason: JobReason;
}

// In-process job queue for incremental indexing. Jobs are deduplicated by file
// path (the latest job for a path wins) and processed one at a time, because
// SQLite has a single writer. A burst of filesystem events for the same file
// collapses to one index pass.
export class IndexQueue {
  private pending = new Map<string, IndexJob>();
  private running = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private process: (job: IndexJob) => Promise<void>) {}

  enqueue(job: IndexJob): void {
    this.pending.set(job.filePath, job);
    void this.drain();
  }

  // Resolves when the queue has fully drained — useful for tests and for a
  // clean shutdown.
  onIdle(): Promise<void> {
    if (!this.running && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  get size(): number {
    return this.pending.size;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const log = getLogger();

    while (this.pending.size > 0) {
      const [path, job] = this.pending.entries().next().value as [string, IndexJob];
      this.pending.delete(path);
      try {
        await this.process(job);
      } catch (err) {
        log.warn({ filePath: job.filePath, err }, "index-queue: job failed");
      }
    }

    this.running = false;
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }
}
