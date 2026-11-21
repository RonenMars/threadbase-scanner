import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationScanner } from "../src/scanner";

const line = (type: string, i: number, text: string) =>
  JSON.stringify({
    type,
    uuid: `u${i}`,
    timestamp: `2026-01-20T10:0${i}:00.000Z`,
    sessionId: "sess-seed",
    cwd: "/home/test/proj",
    message: { role: type, content: [{ type: "text", text }] },
  });

describe("search content export/seed (non-persistent statCache hit)", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seed-"));
    const dir = join(root, "projects", "p");
    mkdirSync(dir, { recursive: true });
    file = join(dir, "sess-seed.jsonl");
    writeFileSync(
      file,
      [
        line("user", 0, "hello"),
        line("assistant", 1, "the zebrafish needle is buried here"),
        line("user", 2, "thanks"),
        line("assistant", 3, "done"),
      ].join("\n") + "\n",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function secondScanner(seed: boolean) {
    const first = new ConversationScanner({ persistent: false });
    const profiles = [{ id: "default", label: "T", configDir: root, enabled: true }];
    await first.scan({ profiles });
    const s = statSync(file);
    const statCache = new Map(
      [...first.getMetadataCache().values()].map((m) => [
        m.filePath,
        { stat: { mtimeMs: s.mtimeMs, size: s.size }, meta: m },
      ]),
    );
    const second = new ConversationScanner({ persistent: false });
    if (seed) second.seedSearchContents(first.exportSearchContents());
    await second.scan({ profiles, statCache });
    return second;
  }

  it("a fresh scanner with statCache hits finds no body text (the bug)", async () => {
    const s = await secondScanner(false);
    expect((await s.search("zebrafish")).length).toBe(0);
  });

  it("seeding the exported bodies restores body search", async () => {
    const s = await secondScanner(true);
    expect((await s.search("zebrafish")).length).toBe(1);
  });
});
