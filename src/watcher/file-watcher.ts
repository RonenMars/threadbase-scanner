import type { FSWatcher } from "chokidar";
import chokidar from "chokidar";
import { getLogger } from "../logger";
import { getProjectsDir } from "../profiles";
import type { Profile } from "../types";

const EXCLUDED_SEGMENTS = ["/memory/", "/tool-results/"];

export interface WatchEvent {
  filePath: string;
  account: string;
  type: "add" | "change" | "unlink";
}

export interface FileWatcherOptions {
  // Debounce window (ms) coalescing rapid events for one file. Spec §8.
  debounceMs?: number;
}

// Watches each active profile's projects dir for *.jsonl changes and forwards
// debounced add/change/unlink events. Thin wrapper over chokidar; the scanner
// owns what to do with the events (enqueue index jobs, emit to host apps).
export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;

  constructor(
    private profiles: Profile[],
    private onEvent: (event: WatchEvent) => void,
    options: FileWatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 400;
  }

  // Resolves once every underlying chokidar watcher has finished its initial
  // scan, so the caller knows subsequent FS changes will be observed.
  async start(): Promise<void> {
    const log = getLogger();
    const ready: Promise<void>[] = [];
    for (const profile of this.profiles) {
      const dir = getProjectsDir(profile);
      const watcher = chokidar.watch(dir, {
        ignoreInitial: true,
        ignored: (p: string) => EXCLUDED_SEGMENTS.some((seg) => p.includes(seg)),
        awaitWriteFinish: { stabilityThreshold: this.debounceMs, pollInterval: 100 },
      });
      watcher
        .on("add", (p) => this.dispatch(p, profile.id, "add"))
        .on("change", (p) => this.dispatch(p, profile.id, "change"))
        .on("unlink", (p) => this.dispatch(p, profile.id, "unlink"));
      ready.push(new Promise<void>((resolve) => watcher.once("ready", () => resolve())));
      this.watchers.push(watcher);
      log.debug({ dir, account: profile.id }, "watcher: watching");
    }
    await Promise.all(ready);
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await Promise.all(this.watchers.map((w) => w.close()));
    this.watchers = [];
  }

  private dispatch(filePath: string, account: string, type: WatchEvent["type"]): void {
    if (!filePath.endsWith(".jsonl")) return;
    // Debounce per path: collapse a flurry of events into the latest one.
    const existing = this.timers.get(filePath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      filePath,
      setTimeout(() => {
        this.timers.delete(filePath);
        this.onEvent({ filePath, account, type });
      }, this.debounceMs),
    );
  }
}
